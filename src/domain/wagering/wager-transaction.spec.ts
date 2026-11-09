import { describe, expect, it } from 'bun:test';
import { Money } from '../common/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import {
  FailureCode, InvalidTransactionError, InvalidTransactionStateError,
  WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from './wager-transaction';

const money = (amount = '25.00', currency = 'BRL') => Money.from({ amount, currency });
const base = (overrides: Partial<CreateWagerTransactionProps> = {}) => ({
  id: 'tx-1', providerId: 'provider-a', externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1', payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1', playerId: 'player-1', roundId: 'round-1',
  gameId: 'game-1', kind: Kind.Bet as CreateWagerTransactionProps['kind'],
  money: money(), ...overrides,
});
const makeReference = (
  kind: CreateWagerTransactionProps['kind'] = Kind.Bet,
) => {
  const tx = WagerTransaction.create(
    base({
      id: 'tx-ref',
      externalTransactionId: 'ext-ref',
      idempotencyKey: 'key-ref',
      kind,
    }),
  );

  tx.markProcessed(undefined, new Date('2026-01-01'));

  return tx;
};

describe('WagerTransaction', () => {
  it('creates a PENDING BET with Money', () => {
    const tx = WagerTransaction.create(base());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });
  it('forbids external OPENING', () => {
    expect(() => WagerTransaction.create(base({ kind: Kind.Opening as never }))).toThrow(InvalidTransactionError);
  });
  it('creates internal OPENING and credits', () => {
    const tx = WagerTransaction.createOpening({ id: 'open-1', walletId: 'w', playerId: 'p', money: money() });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
  it('rejects missing reference on REFUND and ROLLBACK', () => {
    for (const kind of [Kind.Refund, Kind.Rollback] as const) {
      expect(() => WagerTransaction.create(base({ kind }))).toThrow(InvalidTransactionError);
    }
  });
  it('rejects non-positive money', () => {
    expect(() => WagerTransaction.create(base({ money: money('0.00') }))).toThrow(InvalidTransactionError);
  });
  it('accepts a WIN with or without optional reference', () => {
    expect(WagerTransaction.create(base({ kind: Kind.Win })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(base({ kind: Kind.Win, referenceExternalTransactionId: 'ext-ref' })).kind).toBe(Kind.Win);
  });
  it('LOSS does not affect balance or have a ledger direction', () => {
    const tx = WagerTransaction.create(base({ kind: Kind.Loss }));
    expect(tx.affectsBalance()).toBe(false);
    expect(() => tx.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
  it('marks processed and freezes terminal transitions', () => {
    const tx = WagerTransaction.create(base());
    tx.markProcessed(undefined, new Date('2026-03-01'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
  });
  it('marks pending reference then resolves and processes', () => {
    const tx = WagerTransaction.create(base({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-ref' }));
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    tx.assertValidReference(makeReference());
    tx.markProcessed('tx-ref', new Date());
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(tx.isTerminal()).toBe(true);
  });
  it('disallows unresolved reference when processing REFUND', () => {
    const tx = WagerTransaction.create(base({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-ref' }));
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionError);
  });
  it('rejects invalid reference kind', () => {
    const tx = WagerTransaction.create(base({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-ref' }));
    expect(() => tx.assertValidReference(makeReference(Kind.Win))).toThrow(InvalidTransactionError);
  });
  it('rejects different amounts', () => {
    const tx = WagerTransaction.create(base({ kind: Kind.Refund, money: money('24.00'), referenceExternalTransactionId: 'ext-ref' }));
    expect(() => tx.assertValidReference(makeReference())).toThrow(InvalidTransactionError);
  });
  it('rejects different currencies', () => {
    const tx = WagerTransaction.create(base({ kind: Kind.Refund, money: money('25.00', 'USD'), referenceExternalTransactionId: 'ext-ref' }));
    expect(() => tx.assertValidReference(makeReference())).toThrow();
  });
  it('ROLLBACK direction reverses BET, WIN and REFUND', () => {
    for (const [refKind, direction] of [
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ] as const) {
      const ref = WagerTransaction.create(base({
        id: `ref-${refKind}`, externalTransactionId: 'ext-ref',
        idempotencyKey: `key-${refKind}`, kind: refKind,
        ...(refKind === Kind.Refund ? { referenceExternalTransactionId: 'older-bet' } : {}),
      }));
      ref.markProcessed(refKind === Kind.Refund ? 'older-id' : undefined, new Date());
      const rollback = WagerTransaction.create(base({
        kind: Kind.Rollback, referenceExternalTransactionId: 'ext-ref',
      }));
      expect(rollback.ledgerDirectionFor(ref)).toBe(direction);
    }
  });
  it('reject and fail are terminal and expose stable codes', () => {
    const rejected = WagerTransaction.create(base());
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => rejected.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
    const failed = WagerTransaction.create(base());
    failed.fail(FailureCode.InfrastructureFailure);
    expect(failed.status).toBe(Status.Failed);
  });
  it('matches canonical payload hash exactly', () => {
    const tx = WagerTransaction.create(base());
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
  it('rehydrates terminal state without transition validation', () => {
    const tx = WagerTransaction.rehydrate({
      ...base(), money: { amount: '25.00', currency: 'BRL' },
      createdAt: new Date('2026-03-01'),
      status: Status.Processed, processedAt: new Date('2026-04-01'),
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
