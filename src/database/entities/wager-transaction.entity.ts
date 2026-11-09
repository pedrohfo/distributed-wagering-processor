import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../domain/wagering/wager-transaction';

/** Keep persistence state separate from WagerTransaction's domain state machine. */
@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'], name: 'wager_tx_provider_external_unique' })
@Unique({ properties: ['idempotencyKey'], name: 'wager_tx_idempotency_unique' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ type: 'string', fieldName: 'provider_id', columnType: 'text' })
  providerId!: string;

  @Property({ type: 'string', fieldName: 'external_transaction_id', columnType: 'text' })
  externalTransactionId!: string;

  @Property({ type: 'string', fieldName: 'idempotency_key', columnType: 'text' })
  idempotencyKey!: string;

  @Property({ type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ type: 'string', fieldName: 'wallet_id', columnType: 'text' })
  walletId!: string;

  @Property({ type: 'string', fieldName: 'player_id', columnType: 'text' })
  playerId!: string;

  @Property({ type: 'string', fieldName: 'round_id', columnType: 'text', nullable: true })
  roundId?: string | null;

  @Property({ type: 'string', fieldName: 'game_id', columnType: 'text', nullable: true })
  gameId?: string | null;

  @Property({ type: 'string', columnType: 'text' })
  kind!: WagerTransactionKind;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', fieldName: 'reference_external_transaction_id', columnType: 'text', nullable: true })
  referenceExternalTransactionId?: string | null;

  @Property({ type: 'string', fieldName: 'reference_transaction_id', columnType: 'text', nullable: true })
  referenceTransactionId?: string | null;

  @Property({ type: 'string', columnType: 'text' })
  status!: WagerTransactionStatus;

  @Property({
    type: 'string',
    fieldName: 'failure_code',
    columnType: 'text',
    nullable: true,
  })
  failureCode?: FailureCode | null;

  @Property({ type: 'datetime', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  @Property({ type: 'decimal', fieldName: 'observed_balance', precision: 18, scale: 2, nullable: true })
  observedBalanceAmount?: string | null;

  @Property({ type: 'integer', fieldName: 'retry_attempts' })
  retryAttempts!: number;

  @Property({ type: 'datetime', fieldName: 'next_retry_at', columnType: 'timestamptz', nullable: true })
  nextRetryAt?: Date | null;

  @Property({ type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
