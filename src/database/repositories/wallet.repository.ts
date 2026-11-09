import { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletMapper } from '../mappers/wallet.mapper';

/** The supplied EM must be transaction-scoped for all writes and row locks. */
export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async getById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  async getByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id }, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  async findByPlayerCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity === null ? null : WalletMapper.toDomain(entity);
  }

  insert(wallet: Wallet): void {
    this.em.persist(WalletMapper.toEntity(wallet));
  }

  async update(wallet: Wallet): Promise<void> {
    const entity = await this.em.findOneOrFail(WalletEntity, { id: wallet.id }, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    WalletMapper.updateEntity(entity, wallet);
  }
}
