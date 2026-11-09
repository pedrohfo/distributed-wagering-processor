import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from '../common/money';
import { InsufficientFundsError, Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

const wallet = (balance = '100.00') => Wallet.open({
  id: 'wallet-1',
  playerId: 'player-1',
  initialBalance: money(balance),
  at: new Date('2026-01-01T00:00:00Z'),
});

const movement = (amount: string, id: string) => ({
  ledgerEntryId: `ledger-${id}`,
  transactionId: `transaction-${id}`,
  money: money(amount),
  at: new Date('2026-01-02T00:00:00Z'),
});

describe('Wallet', () => {
  it('starts at version one and requires opening ledger for initial funds', () => {
    const aggregate = wallet();
    const opening = aggregate.openingEntry({
      ledgerEntryId: 'ledger-opening',
      transactionId: 'transaction-opening',
    });
    expect(aggregate.version).toBe(1);
    expect(opening?.direction).toBe(LedgerDirection.Credit);
    expect(opening?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(opening?.balanceAfter.toJSON().amount).toBe('100.00');
    expect(opening?.isBalanced()).toBe(true);
  });

  it('does not create opening ledger for zero balance', () => {
    expect(wallet('0.00').openingEntry({
      ledgerEntryId: 'ledger-0', transactionId: 'transaction-0',
    })).toBeNull();
  });

  it('debits, updates version and produces balanced ledger entry', () => {
    const aggregate = wallet();
    const entry = aggregate.debit(movement('80.00', 'bet'));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
    expect(aggregate.balance.toJSON().amount).toBe('20.00');
    expect(aggregate.version).toBe(2);
  });

  it('does not mutate state on insufficient funds', () => {
    const aggregate = wallet();
    aggregate.debit(movement('80.00', 'bet-1'));
    expect(() => aggregate.debit(movement('80.00', 'bet-2')))
      .toThrow(InsufficientFundsError);
    expect(aggregate.balance.toJSON().amount).toBe('20.00');
    expect(aggregate.version).toBe(2);
  });

  it('credits and creates a credit entry', () => {
    const aggregate = wallet('0.00');
    const entry = aggregate.credit(movement('12.34', 'win'));
    expect(entry.isBalanced()).toBe(true);
    expect(aggregate.balance.toJSON().amount).toBe('12.34');
    expect(aggregate.version).toBe(2);
  });

  it('rejects mismatched currency and zero amounts', () => {
    const aggregate = wallet();
    expect(() => aggregate.debit({ ...movement('1.00', 'x'), money: money('1.00', 'USD') }))
      .toThrow(CurrencyMismatchError);
    expect(() => aggregate.credit(movement('0.00', 'y'))).toThrow();
    expect(aggregate.version).toBe(1);
  });

  it('rejects ledger entries with incorrect before/after arithmetic', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'entry', walletId: 'wallet', transactionId: 'txn',
      direction: LedgerDirection.Debit,
      money: money('10.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('95.00'),
      createdAt: new Date(),
    })).toThrow('Ledger entry does not balance');
  });

  it('returns defensive Date copies from immutable ledger', () => {
    const entry = wallet().openingEntry({ ledgerEntryId: 'e', transactionId: 't' });
    if (!entry) throw new Error('Expected opening entry');
    const first = entry.createdAt;
    first.setFullYear(1999);
    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  });
});
