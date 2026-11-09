import {
  FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

const OPENING_MARKER = '__opening__';

function enumValue<T extends string>(value: string, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new Error(`Unknown ${label}: ${value}`);
  return value as T;
}

export class WagerTransactionMapper {
  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    const kind = enumValue(entity.kind, Object.values(WagerTransactionKind), 'transaction kind');
    const status = enumValue(entity.status, Object.values(WagerTransactionStatus), 'transaction status');
    const failureCode = entity.failureCode == null ? undefined
      : enumValue(entity.failureCode, Object.values(FailureCode), 'failure code');
    if (kind !== WagerTransactionKind.Opening && (entity.roundId == null || entity.gameId == null)) {
      throw new Error('Non-OPENING transactions require roundId and gameId');
    }
    return WagerTransaction.rehydrate({
      id: entity.id, providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey, payloadHash: entity.payloadHash,
      walletId: entity.walletId, playerId: entity.playerId,
      roundId: kind === WagerTransactionKind.Opening ? OPENING_MARKER : entity.roundId!,
      gameId: kind === WagerTransactionKind.Opening ? OPENING_MARKER : entity.gameId!,
      kind, money: { amount: entity.amount, currency: entity.currency },
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      status, referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode, processedAt: entity.processedAt ?? undefined,
      createdAt: entity.createdAt,
    });
  }

  static toEntity(tx: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    entity.id = tx.id;
    entity.providerId = tx.providerId;
    entity.externalTransactionId = tx.externalTransactionId;
    entity.idempotencyKey = tx.idempotencyKey;
    entity.payloadHash = tx.payloadHash;
    entity.walletId = tx.walletId;
    entity.playerId = tx.playerId;
    entity.roundId = tx.kind === WagerTransactionKind.Opening ? null : tx.roundId;
    entity.gameId = tx.kind === WagerTransactionKind.Opening ? null : tx.gameId;
    entity.kind = tx.kind;
    entity.amount = tx.money.toJSON().amount;
    entity.currency = tx.money.currency;
    entity.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
    entity.createdAt = tx.createdAt;
    entity.retryAttempts = 0;
    entity.nextRetryAt = null;
    entity.observedBalanceAmount = null;
    this.updateState(entity, tx);
    return entity;
  }

  static updateState(entity: WagerTransactionEntity, tx: WagerTransaction): void {
    if (entity.id !== tx.id) throw new Error('Transaction identity mismatch');
    entity.status = tx.status;
    entity.referenceTransactionId = tx.referenceTransactionId ?? null;
    entity.failureCode = tx.failureCode ?? null;
    entity.processedAt = tx.processedAt ?? null;
  }
}
