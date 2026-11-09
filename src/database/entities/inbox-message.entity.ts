import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Composite key prevents processing the same SQS message twice per consumer. */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', fieldName: 'consumer_name', columnType: 'text' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', fieldName: 'message_id', columnType: 'text' })
  messageId!: string;

  @Property({ type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ type: 'datetime', fieldName: 'received_at', columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'datetime', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt?: Date | null;
}
