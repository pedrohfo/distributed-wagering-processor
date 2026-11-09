import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { WagerTransactionEntity } from '../../database/entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../../database/mappers/wager-transaction.mapper';
import { WagerTransactionRepository } from '../../database/repositories/wager-transaction.repository';
import { WalletRepository } from '../../database/repositories/wallet.repository';
import { WalletLedgerRepository } from '../../database/repositories/wallet-ledger.repository';
import { OutboxRepository } from '../../database/repositories/outbox.repository';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from '../../domain/messaging/events/wager-events';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import { InsufficientFundsError } from '../../domain/wallet/wallet';
import {
  FailureCode, InvalidTransactionError,
  WagerTransactionKind as Kind, WagerTransactionStatus as Status,
} from '../../domain/wagering/wager-transaction';

export interface PendingReferenceWorkerOptions {
  /** Maximum age from original transaction creation before permanent rejection. */
  ttlMs?: number;
  /** Maximum unsuccessful reference-lookup attempts (excluding initial ingestion). */
  maxAttempts?: number;
  /** Retry delay starts at baseDelayMs and doubles, capped by maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}
export interface RecoveryBatchResult {
  claimed: number;
  processed: number;
  rejected: number;
  rescheduled: number;
}

type RecoveryOutcome = 'processed' | 'rejected' | 'rescheduled';

/** Pure scheduling helper, deliberately separate from I/O for deterministic tests. */
export function nextReferenceRetry(
  createdAt: Date, now: Date, attempt: number,
  options: Required<PendingReferenceWorkerOptions>,
): Date {
  const delay = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** Math.min(attempt - 1, 30)));
  return new Date(Math.min(now.getTime() + delay, createdAt.getTime() + options.ttlMs));
}

/**
 * Each claim and financial transition is committed in one PostgreSQL transaction.
 * SKIP LOCKED permits competing workers to claim different rows rather than duplicate work.
 * The wallet is separately locked before balance changes. Do not reuse an EntityManager
 * across concurrently running service calls: pass a fork to each worker instance.
 */
export class PendingReferenceWorkerService {
  private readonly options: Required<PendingReferenceWorkerOptions>;

  constructor(private readonly em: EntityManager, options: PendingReferenceWorkerOptions = {}) {
    this.options = {
      ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000,
      maxAttempts: options.maxAttempts ?? 12,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 60 * 60 * 1000,
    };
    const o = this.options;
    if (![o.ttlMs, o.maxAttempts, o.baseDelayMs, o.maxDelayMs].every(Number.isSafeInteger) ||
      o.ttlMs <= 0 || o.maxAttempts <= 0 || o.baseDelayMs <= 0 || o.maxDelayMs < o.baseDelayMs) {
      throw new Error('Invalid pending-reference retry configuration');
    }
  }

  /** One polling cycle; a scheduler/worker lifecycle will be added with SQS integration. */
  async runOnce(options: { now?: Date; limit?: number; transactionId?: string } = {}): Promise<RecoveryBatchResult> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 20;
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid recovery clock');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Recovery batch limit must be 1..500');
    }
    const result: RecoveryBatchResult = { claimed: 0, processed: 0, rejected: 0, rescheduled: 0 };
    for (let i = 0; i < limit; i++) {
      const outcome = await this.processNextDue(now, options.transactionId);
      if (outcome === null) break;
      result.claimed++;
      result[outcome]++;
    }
    return result;
  }

  private async processNextDue(now: Date, transactionId?: string): Promise<RecoveryOutcome | null> {
    return this.em.transactional(async (txEm) => {
      // Supported by MikroORM/PostgreSQL as SELECT ... FOR UPDATE SKIP LOCKED.
      const entity = await txEm.findOne(WagerTransactionEntity, {
        status: Status.PendingReference,
        ...(transactionId ? { id: transactionId } : {}),
        nextRetryAt: { $lte: now },
      }, {
        orderBy: { nextRetryAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      });
      if (!entity) return null;

      const tx = WagerTransactionMapper.toDomain(entity);
      const repo = new WagerTransactionRepository(txEm);
      const wallets = new WalletRepository(txEm);
      const ledger = new WalletLedgerRepository(txEm);
      const outbox = new OutboxRepository(txEm);
      const observed = () => entity.observedBalanceAmount;

      if (!tx.requiresReference() || !tx.referenceExternalTransactionId) {
        throw new Error(`Invalid persisted PENDING_REFERENCE transaction: ${tx.id}`);
      }
      // Lock wallet before reading its balance, applying movement, or checking reversals.
      const wallet = await wallets.getByIdForUpdate(tx.walletId);
      if (!wallet) throw new Error(`Missing wallet for pending transaction: ${tx.id}`);
      if (wallet.playerId !== tx.playerId || wallet.currency !== tx.money.currency) {
        throw new Error(`Persisted wallet identity mismatch for ${tx.id}`);
      }

      const reject = async (code: FailureCode): Promise<'rejected'> => {
        tx.reject(code);
        await repo.updateState(tx, observed() ?? wallet.balance.toJSON().amount);
        entity.nextRetryAt = null;
        outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, {
          eventId: randomUUID(), correlationId: tx.id, occurredAt: now,
        })));
        await txEm.flush();
        return 'rejected';
      };

      // Expired work cannot be resurrected by a reference that arrives later.
      if (now.getTime() >= tx.createdAt.getTime() + this.options.ttlMs) {
        return reject(FailureCode.ReferenceNotFound);
      }

      const reference = await repo.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
      if (!reference || !reference.isTerminal()) {
        const attempts = entity.retryAttempts + 1;
        if (attempts >= this.options.maxAttempts) return reject(FailureCode.ReferenceNotFound);
        entity.retryAttempts = attempts;
        entity.nextRetryAt = nextReferenceRetry(tx.createdAt, now, attempts, this.options);
        await txEm.flush();
        return 'rescheduled';
      }

      try {
        tx.assertValidReference(reference);
      } catch (error) {
        if (!(error instanceof InvalidTransactionError)) throw error;
        return reject(FailureCode.InvalidReference);
      }

      // Second check under the wallet lock; the partial unique index also provides
      // final defense against two processed reversals of the same kind/reference.
      const previous = await txEm.findOne(WagerTransactionEntity, {
        providerId: tx.providerId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        kind: tx.kind,
        status: Status.Processed,
      });
      if (previous) return reject(FailureCode.DuplicateReversal);

      let entry: ReturnType<typeof wallet.credit>;
      try {
        const direction = tx.ledgerDirectionFor(reference);
        const movement = {
          ledgerEntryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now,
        };
        entry = direction === LedgerDirection.Debit
          ? wallet.debit(movement) : wallet.credit(movement);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        return reject(tx.kind === Kind.Bet
          ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds);
      }

      tx.markProcessed(reference.id, now);
      await repo.updateState(tx, wallet.balance.toJSON().amount);
      entity.nextRetryAt = null;
      await wallets.update(wallet);
      ledger.insert(entry);
      const ctx = { eventId: randomUUID(), correlationId: tx.id, occurredAt: now };
      const event = WagerTransactionProcessed.from(tx, ctx);
      outbox.insert(OutboxMessage.enqueue(event));
      outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, {
        ...ctx, eventId: randomUUID(), causationId: event.eventId,
      })));
      await txEm.flush();
      return 'processed';
    }, { clear: true });
  }
}
