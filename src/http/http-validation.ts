import { BadRequestException } from '@nestjs/common';
import { Money } from '../domain/common/money';
import { WagerTransactionKind } from '../domain/wagering/wager-transaction';
import type { ProcessWagerCommand } from '../application/wagering/process-wager.service';

export function object(value: unknown, field = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringField(o: Record<string, unknown>, field: string): string {
  const value = o[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required and must be a nonempty string`);
  }
  return value;
}

export function moneyField(value: unknown): { amount: string; currency: string } {
  const o = object(value, 'money');
  const amount = stringField(o, 'amount');
  const currency = stringField(o, 'currency');
  try {
    return Money.from({ amount, currency }).toJSON();
  } catch {
    throw new BadRequestException('Invalid money amount/currency (exact decimal string required)');
  }
}

export function wagerCommand(value: unknown, idempotencyKey: string | undefined): ProcessWagerCommand {
  const o = object(value);
  if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key header is required');
  const kind = stringField(o, 'kind');
  const allowed: readonly string[] = [
    WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
    WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
  ];
  if (!allowed.includes(kind)) throw new BadRequestException('Invalid external wager kind');
  const reference = o.referenceExternalTransactionId;
  if (reference !== undefined && (typeof reference !== 'string' || !reference.trim())) {
    throw new BadRequestException('referenceExternalTransactionId must be a nonempty string');
  }
  return {
    idempotencyKey,
    providerId: stringField(o, 'providerId'),
    externalTransactionId: stringField(o, 'externalTransactionId'),
    walletId: stringField(o, 'walletId'),
    playerId: stringField(o, 'playerId'),
    roundId: stringField(o, 'roundId'),
    gameId: stringField(o, 'gameId'),
    kind: kind as ProcessWagerCommand['kind'],
    money: moneyField(o.money),
    ...(typeof reference === 'string' ? { referenceExternalTransactionId: reference } : {}),
  };
}
