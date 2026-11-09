import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { WagerTransactionKind as Kind } from '../domain/wagering/wager-transaction';
import { moneyField, wagerCommand } from './http-validation';

const request = () => ({
  providerId: 'provider-a', externalTransactionId: 'ext-1',
  walletId: 'wallet-1', playerId: 'player-1',
  roundId: 'round-1', gameId: 'game-1', kind: Kind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
});

describe('HTTP boundary validation', () => {
  it('accepts a valid wager with its header-based idempotency key', () => {
    expect(wagerCommand(request(), 'provider-a:ext-1').idempotencyKey).toBe('provider-a:ext-1');
  });
  it('rejects an absent Idempotency-Key header', () => {
    expect(() => wagerCommand(request(), undefined)).toThrow(BadRequestException);
  });
  it('rejects externally supplied OPENING', () => {
    expect(() => wagerCommand({ ...request(), kind: Kind.Opening }, 'key')).toThrow(BadRequestException);
  });
  it('rejects floating point input for money', () => {
    expect(() => moneyField({ amount: 25.5, currency: 'BRL' })).toThrow(BadRequestException);
  });
  it('rejects noncanonical monetary precision', () => {
    expect(() => moneyField({ amount: '25.001', currency: 'BRL' })).toThrow(BadRequestException);
  });
});
