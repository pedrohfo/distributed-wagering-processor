import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** A durable event publication job. Publisher workers own the retry loop. */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'string', columnType: 'text' })
  id!: string;

  @Property({ type: 'string', fieldName: 'aggregate_id', columnType: 'text' })
  aggregateId!: string;

  @Property({ type: 'string', fieldName: 'event_type', columnType: 'text' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime', fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'datetime', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true })
  nextAttemptAt?: Date | null;

  @Property({ type: 'datetime', fieldName: 'published_at', columnType: 'timestamptz', nullable: true })
  publishedAt?: Date | null;
}
