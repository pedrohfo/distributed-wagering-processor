import { InboxMessage } from '../../domain/messaging/inbox-message';
import { InboxMessageEntity } from '../entities/inbox-message.entity';

export class InboxMessageMapper {
  static toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName, messageId: entity.messageId,
      payloadHash: entity.payloadHash, receivedAt: entity.receivedAt,
      processedAt: entity.processedAt ?? undefined,
    });
  }

  static toEntity(message: InboxMessage): InboxMessageEntity {
    const entity = new InboxMessageEntity();
    entity.consumerName = message.consumerName;
    entity.messageId = message.messageId;
    entity.payloadHash = message.payloadHash;
    entity.receivedAt = message.receivedAt;
    entity.processedAt = message.processedAt ?? null;
    return entity;
  }

  static updateEntity(entity: InboxMessageEntity, message: InboxMessage): void {
    if (entity.consumerName !== message.consumerName || entity.messageId !== message.messageId ||
        entity.payloadHash !== message.payloadHash) throw new Error('Inbox message identity/payload mismatch');
    entity.processedAt = message.processedAt ?? null;
  }
}
