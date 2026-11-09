import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';

/** Append-only ledger record. Database triggers reject UPDATE, DELETE and TRUNCATE. */
@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['walletId', 'transactionId'], name: 'ledger_one_entry_per_tx_wallet' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ type: 'string', fieldName: 'wallet_id', columnType: 'text' })
  walletId!: string;

  @Property({ type: 'string', fieldName: 'transaction_id', columnType: 'text' })
  transactionId!: string;

  @Property({ type: 'string', columnType: 'text' })
  direction!: LedgerDirection;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'decimal', fieldName: 'balance_before', precision: 18, scale: 2 })
  balanceBeforeAmount!: string;

  @Property({ type: 'decimal', fieldName: 'balance_after', precision: 18, scale: 2 })
  balanceAfterAmount!: string;

  @Property({ type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
