import { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { InboxMessageEntity } from '../entities/inbox-message.entity';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper';

/** For competing consumers use the DB composite unique key as the deduplication arbiter. */
export class InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageEntity, { consumerName, messageId });
    return entity ? InboxMessageMapper.toDomain(entity) : null;
  }

  insert(message: InboxMessage): void {
    this.em.persist(InboxMessageMapper.toEntity(message));
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const entity = await this.em.findOneOrFail(InboxMessageEntity, {
      consumerName: message.consumerName, messageId: message.messageId,
    });
    InboxMessageMapper.updateEntity(entity, message);
  }
}
