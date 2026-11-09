import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/common/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  WagerTransactionProcessed, WalletBalanceChanged,
} from '../../domain/messaging/events/wager-events';
import { WalletRepository } from '../../database/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../database/repositories/wager-transaction.repository';
import { WalletLedgerRepository } from '../../database/repositories/wallet-ledger.repository';
import { OutboxRepository } from '../../database/repositories/outbox.repository';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

/**
 * All database writes and integration-event enqueue operations share one SQL transaction.
 * PostgreSQL uniqueness/ledger consistency checks remain the final arbiter.
 */
export class CreateWalletService {
  constructor(private readonly em: EntityManager) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    if (!command.playerId?.trim()) throw new Error('playerId is required');
    const walletId = randomUUID();
    const at = new Date();

    return this.em.transactional(async (txEm) => {
      const wallets = new WalletRepository(txEm);
      const transactions = new WagerTransactionRepository(txEm);
      const ledger = new WalletLedgerRepository(txEm);
      const outbox = new OutboxRepository(txEm);

      const wallet = Wallet.open({
        id: walletId, playerId: command.playerId,
        initialBalance, at,
      });
      wallets.insert(wallet);
      await txEm.flush();

      if (!initialBalance.isZero()) {
        const openingId = randomUUID();
        const entry = wallet.openingEntry({
          ledgerEntryId: randomUUID(), transactionId: openingId,
        });
        if (entry === null) throw new Error('Opening ledger entry unexpectedly missing');
        const opening = WagerTransaction.createOpening({
          id: openingId, walletId: wallet.id, playerId: wallet.playerId,
          money: initialBalance, createdAt: at,
        });
        opening.markProcessed(undefined, at);
        transactions.insert(opening);
        await txEm.flush();

        ledger.insert(entry);
        await txEm.flush();

        const correlationId = openingId;
        const processed = WagerTransactionProcessed.from(opening, {
          eventId: randomUUID(), correlationId, occurredAt: at,
        });
        const balanceChanged = WalletBalanceChanged.from(wallet, entry, {
          eventId: randomUUID(), correlationId,
          causationId: processed.eventId, occurredAt: at,
        });
        outbox.insert(OutboxMessage.enqueue(processed));
        outbox.insert(OutboxMessage.enqueue(balanceChanged));
      }

      // Flush is explicit so SQL checks are not deferred until some later unit-of-work.
      // COMMIT (including deferred PostgreSQL constraint triggers) occurs when transactional() resolves.
      await txEm.flush();
      return wallet;
    });
  }
}
