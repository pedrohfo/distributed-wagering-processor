import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';

export class WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  insert(transaction: WagerTransaction): void {
    this.em.persist(WagerTransactionMapper.toEntity(transaction));
  }

  async updateState(transaction: WagerTransaction, observedBalanceAmount?: string): Promise<void> {
    const entity = await this.em.findOneOrFail(WagerTransactionEntity, { id: transaction.id });
    WagerTransactionMapper.updateState(entity, transaction);
    if (observedBalanceAmount !== undefined) entity.observedBalanceAmount = observedBalanceAmount;
  }
}
