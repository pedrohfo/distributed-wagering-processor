import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';

export class OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  insert(message: OutboxMessage): void {
    this.em.persist(OutboxMessageMapper.toEntity(message));
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const entity = await this.em.findOne(OutboxMessageEntity, { id });
    return entity ? OutboxMessageMapper.toDomain(entity) : null;
  }

  async updateState(message: OutboxMessage): Promise<void> {
    const entity = await this.em.findOneOrFail(OutboxMessageEntity, { id: message.id });
    OutboxMessageMapper.updateState(entity, message);
  }
}
