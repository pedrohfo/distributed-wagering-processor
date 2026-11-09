import { Wallet } from '../../domain/wallet/wallet';
import { WalletEntity } from '../entities/wallet.entity';

export class WalletMapper {
  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id, playerId: entity.playerId, currency: entity.currency,
      balance: { amount: entity.balanceAmount, currency: entity.currency },
      version: entity.version, createdAt: entity.createdAt, updatedAt: entity.updatedAt,
    });
  }

  static toEntity(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balanceAmount = wallet.balance.toJSON().amount;
    entity.version = wallet.version;
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    return entity;
  }

  static updateEntity(entity: WalletEntity, wallet: Wallet): void {
    if (entity.id !== wallet.id || entity.playerId !== wallet.playerId || entity.currency !== wallet.currency) {
      throw new Error('Wallet identity mismatch');
    }
    entity.balanceAmount = wallet.balance.toJSON().amount;
    entity.version = wallet.version;
    entity.updatedAt = wallet.updatedAt;
  }
}
