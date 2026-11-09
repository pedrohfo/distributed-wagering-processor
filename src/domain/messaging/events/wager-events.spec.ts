import { describe, expect, it } from 'bun:test';
import { Money } from '../../common/money';
import { Wallet } from '../../wallet/wallet';
import { WagerTransaction, WagerTransactionKind as Kind, FailureCode } from '../../wagering/wager-transaction';
import { OutboxMessage } from '../outbox-message';
import {
  WagerTransactionProcessed, WagerTransactionRejected,
  WagerTransactionPendingReference, WalletBalanceChanged,
  type EventContext,
} from './wager-events';

const now = new Date('2026-01-01T00:00:00.000Z');
const ctx: EventContext = { eventId: 'event-1', correlationId: 'corr-1', causationId: 'sqs-1', occurredAt: now };
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const transaction = (kind: Exclude<Kind, Kind.Opening> = Kind.Bet) => WagerTransaction.create({
  id: 'tx-1', providerId: 'provider-1', externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1', payloadHash: 'a'.repeat(64), walletId: 'wallet-1',
  playerId: 'player-1', roundId: 'round-1', gameId: 'game-1', kind,
  money: brl('25.00'),
  ...(kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: 'original' } : {}),
});

describe('Concrete integration events', () => {
  it('creates processed event for LOSS without requiring a ledger', () => {
    const tx = transaction(Kind.Loss); tx.markProcessed(undefined, now);
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(event.toJSON().eventType).toBe('WagerTransactionProcessed');
    expect(event.data.kind).toBe(Kind.Loss);
    expect(event.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(OutboxMessage.enqueue(event).eventType).toBe('WagerTransactionProcessed');
  });
  it('refuses processed events for pending transactions', () => {
    expect(() => WagerTransactionProcessed.from(transaction(), ctx)).toThrow();
  });
  it('creates rejected event only after business rejection', () => {
    const tx = transaction(); tx.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(tx, ctx).data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow();
  });
  it('creates pending-reference event only when the state is pending-reference', () => {
    const tx = transaction(Kind.Refund);
    expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow();
    tx.markPendingReference();
    expect(WagerTransactionPendingReference.from(tx, ctx).data.referenceExternalTransactionId).toBe('original');
  });
  it('creates balance changed event only for matching updated wallet and ledger', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00'), at: now });
    const entry = wallet.debit({ transactionId: 'tx-1', ledgerEntryId: 'ledger-1', money: brl('25.00'), at: now });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.data.balanceBefore.amount).toBe('100.00');
    expect(event.data.balanceAfter.amount).toBe('75.00');
    expect(event.data.walletVersion).toBe(2);
    expect(event.toJSON().aggregateId).toBe('wallet-1');
  });
  it('prevents emitting balance-changed event when wallet does not match ledger after state', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00'), at: now });
    const entry = wallet.debit({ transactionId: 'tx-1', ledgerEntryId: 'ledger-1', money: brl('25.00'), at: now });
    const other = Wallet.open({ id: 'wallet-2', playerId: 'player-1', initialBalance: brl('75.00'), at: now });
    expect(() => WalletBalanceChanged.from(other, entry, ctx)).toThrow();
  });
});
