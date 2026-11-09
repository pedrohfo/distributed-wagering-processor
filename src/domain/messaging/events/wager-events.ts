import { type MoneyProps } from '../../common/money';
import { Wallet } from '../../wallet/wallet';
import { WalletLedgerEntry, LedgerDirection } from '../../wallet/wallet-ledger-entry';
import {
  WagerTransaction, WagerTransactionStatus, type FailureCode,
} from '../../wagering/wager-transaction';
import { IntegrationEvent, type IntegrationEventProps } from '../integration-event';

/** IDs and causality are supplied by the application service, not generated in the domain. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

function envelope<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
  return { ...ctx, aggregateId, data };
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransaction['kind'];
  status: WagerTransactionStatus.Processed;
  money: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) { super(props); }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || !tx.processedAt) {
      throw new Error('WagerTransactionProcessed requires a processed transaction');
    }
    return new WagerTransactionProcessed(envelope(tx.id, ctx, {
      transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId, playerId: tx.playerId,
      roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind,
      status: WagerTransactionStatus.Processed, money: tx.money.toJSON(),
      ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
      processedAt: tx.processedAt.toISOString(),
    }));
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransaction['kind'];
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) { super(props); }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || !tx.failureCode) {
      throw new Error('WagerTransactionRejected requires a rejected transaction with failureCode');
    }
    return new WagerTransactionRejected(envelope(tx.id, ctx, {
      transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId, kind: tx.kind,
      status: WagerTransactionStatus.Rejected, failureCode: tx.failureCode,
    }));
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (wallet.id !== entry.walletId || !wallet.balance.equals(entry.balanceAfter)) {
      throw new Error('Wallet and ledger entry must identify the same updated balance');
    }
    if (!entry.isBalanced()) throw new Error('Ledger entry is not balanced');
    return new WalletBalanceChanged(envelope(wallet.id, ctx, {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    }));
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  kind: WagerTransaction['kind'];
  status: WagerTransactionStatus.PendingReference;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) { super(props); }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.status !== WagerTransactionStatus.PendingReference || !tx.referenceExternalTransactionId) {
      throw new Error('WagerTransactionPendingReference requires an unresolved reference');
    }
    return new WagerTransactionPendingReference(envelope(tx.id, ctx, {
      transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      kind: tx.kind, status: WagerTransactionStatus.PendingReference,
    }));
  }
}
