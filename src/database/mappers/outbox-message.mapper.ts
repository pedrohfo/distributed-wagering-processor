import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';

export class OutboxMessageMapper {
  static toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id, aggregateId: entity.aggregateId, eventType: entity.eventType,
      payload: entity.payload, occurredAt: entity.occurredAt,
      attempts: entity.attempts, nextAttemptAt: entity.nextAttemptAt ?? undefined,
      publishedAt: entity.publishedAt ?? undefined,
    });
  }

  static toEntity(message: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = { ...message.payload };
    entity.occurredAt = message.occurredAt;
    this.updateState(entity, message);
    return entity;
  }

  static updateState(entity: OutboxMessageEntity, message: OutboxMessage): void {
    if (entity.id !== message.id) throw new Error('Outbox identity mismatch');
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt ?? null;
    entity.publishedAt = message.publishedAt ?? null;
  }
}
