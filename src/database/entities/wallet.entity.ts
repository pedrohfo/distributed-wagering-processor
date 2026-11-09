import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/** Persistence model only. Financial arithmetic belongs to the Wallet domain aggregate. */
@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'], name: 'wallets_player_currency_unique' })
export class WalletEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ type: 'string', fieldName: 'player_id', columnType: 'text' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'decimal', fieldName: 'balance', precision: 18, scale: 2 })
  balanceAmount!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'datetime', fieldName: 'updated_at', columnType: 'timestamptz' })
  updatedAt!: Date;
}
