import { createHash, randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/common/money';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import { InsufficientFundsError } from '../../domain/wallet/wallet';
import {
  FailureCode, InvalidTransactionError, WagerTransaction,
  WagerTransactionKind as Kind, WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../domain/wagering/wager-transaction';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  WagerTransactionPendingReference, WagerTransactionProcessed,
  WagerTransactionRejected, WalletBalanceChanged,
} from '../../domain/messaging/events/wager-events';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity';
import { WalletRepository } from '../../database/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../database/repositories/wager-transaction.repository';
import { WalletLedgerRepository } from '../../database/repositories/wallet-ledger.repository';
import { OutboxRepository } from '../../database/repositories/outbox.repository';

export interface ProcessWagerCommand {
  /** Value of the mandatory Idempotency-Key HTTP header. */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: CreateWagerTransactionProps['kind'];
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: Status;
  balance: { amount: string; currency: string };
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key or provider transaction ID already used for different request') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletNotFoundError extends Error {
  constructor() { super('Wallet not found'); this.name = 'WalletNotFoundError'; }
}

/**
 * The hash is over a documented, fixed-order, canonical business-field tuple.
 * No HTTP headers, tracing fields, or idempotency key participate.
 */
export function hashWagerPayload(input: Omit<ProcessWagerCommand, 'idempotencyKey'>): string {
  const canonical = JSON.stringify({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Uses the same transaction-scoped EntityManager for every write and locks a
 * wallet row before making any decision that may affect its money.
 */
export class ProcessWagerService {
  constructor(private readonly em: EntityManager) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const amount = Money.from(command.money);
    if (!command.idempotencyKey?.trim()) throw new InvalidTransactionError('Idempotency-Key is required');
    // Validate every input BEFORE opening the transaction (including the runtime kind check).
    const tx = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hashWagerPayload({
        providerId: command.providerId, externalTransactionId: command.externalTransactionId,
        playerId: command.playerId, walletId: command.walletId,
        roundId: command.roundId, gameId: command.gameId,
        kind: command.kind, money: amount.toJSON(),
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      }),
      walletId: command.walletId, playerId: command.playerId,
      roundId: command.roundId, gameId: command.gameId,
      kind: command.kind, money: amount,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    return this.em.transactional(async (txEm) => {
      const wallets = new WalletRepository(txEm);
      const transactions = new WagerTransactionRepository(txEm);
      const ledger = new WalletLedgerRepository(txEm);
      const outbox = new OutboxRepository(txEm);

      // Early replay lookup handles retries even if the wallet was removed from an API cache.
      const prior = await transactions.findByIdempotencyKey(tx.idempotencyKey);
      if (prior) return this.replay(prior, tx, txEm);

      // Locks serialize independent wager requests for the same wallet across processes.
      const wallet = await wallets.getByIdForUpdate(command.walletId);
      if (!wallet) throw new WalletNotFoundError();
      if (wallet.playerId !== tx.playerId || wallet.currency !== tx.money.currency) {
        throw new InvalidTransactionError('Wallet/player/currency mismatch');
      }

      // Required after acquiring the lock: another request may have committed while waiting.
      const afterLock = await transactions.findByIdempotencyKey(tx.idempotencyKey);
      if (afterLock) return this.replay(afterLock, tx, txEm);
      const externalDuplicate = await transactions.findByProviderExternalId(tx.providerId, tx.externalTransactionId);
      if (externalDuplicate) throw new IdempotencyConflictError();

      let reference: WagerTransaction | null = null;
      if (tx.referenceExternalTransactionId) {
        reference = await transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
      }

      const now = new Date();
      if (tx.requiresReference() && !reference) {
        tx.markPendingReference();
      } else if (reference) {
        try {
          tx.assertValidReference(reference);
        } catch (error) {
          if (!(error instanceof InvalidTransactionError)) throw error;
          tx.reject(FailureCode.InvalidReference);
        }
      }

      // Serialize repeated reversals of one reference by locking its wallet first.
      if (tx.requiresReference() && reference && tx.status === Status.Pending) {
        const previous = await txEm.findOne(WagerTransactionEntity, {
          providerId: tx.providerId,
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          kind: tx.kind,
          status: Status.Processed,
        });
        if (previous) tx.reject(FailureCode.DuplicateReversal);
      }

      // Insert and flush the PENDING/REJECTED transaction before its ledger, due to
      // immediate PostgreSQL foreign keys (deferred reconciliation is separate).
      transactions.insert(tx);
      await txEm.flush();

      let entry: ReturnType<typeof wallet.debit> | undefined;
      if (tx.status === Status.Pending) {
        if (tx.kind === Kind.Win && tx.referenceExternalTransactionId && !reference) {
          tx.reject(FailureCode.InvalidReference);
        } else if (tx.kind === Kind.Loss) {
          tx.markProcessed(undefined, now);
        } else {
          const direction = tx.ledgerDirectionFor(reference ?? undefined);
          try {
            const movement = { ledgerEntryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now };
            entry = direction === LedgerDirection.Debit
              ? wallet.debit(movement) : wallet.credit(movement);
            tx.markProcessed(reference?.id, now);
          } catch (error) {
            if (!(error instanceof InsufficientFundsError)) throw error;
            tx.reject(tx.kind === Kind.Bet
              ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds);
          }
        }
      }

      // An observed balance is persisted for every outcome, including rejected and pending.
      const balance = wallet.balance.toJSON();
      await transactions.updateState(tx, balance.amount);
      const ctx = { eventId: randomUUID(), correlationId: tx.id, occurredAt: now };
      if (tx.status === Status.Processed) {
        if (entry) {
          await wallets.update(wallet);
          ledger.insert(entry);
        }
        const processed = WagerTransactionProcessed.from(tx, ctx);
        outbox.insert(OutboxMessage.enqueue(processed));
        if (entry) {
          outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, {
            ...ctx, eventId: randomUUID(), causationId: processed.eventId,
          })));
        }
      } else if (tx.status === Status.Rejected) {
        outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx)));
      } else if (tx.status === Status.PendingReference) {
        outbox.insert(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx)));
        // The worker for this durable schedule is part of Phase 5B.
        const entity = await txEm.findOneOrFail(WagerTransactionEntity, { id: tx.id });
        entity.nextRetryAt = new Date(now.getTime() + 1_000);
      }

      await txEm.flush();
      return { transactionId: tx.id, status: tx.status, balance,
        ...(tx.failureCode ? { failureCode: tx.failureCode } : {}), idempotentReplay: false };
    });
  }

  private async replay(
    stored: WagerTransaction,
    incoming: WagerTransaction,
    em: EntityManager,
  ): Promise<ProcessWagerResult> {
    if (!stored.matchesPayload(incoming.payloadHash)) throw new IdempotencyConflictError();
    const entity = await em.findOneOrFail(WagerTransactionEntity, { id: stored.id });
    if (entity.observedBalanceAmount == null) {
      throw new Error('Stored transaction missing observed balance; cannot safely replay');
    }
    return {
      transactionId: stored.id,
      status: stored.status,
      balance: { amount: entity.observedBalanceAmount, currency: stored.money.currency },
      ...(stored.failureCode ? { failureCode: stored.failureCode } : {}),
      idempotentReplay: true,
    };
  }
}
