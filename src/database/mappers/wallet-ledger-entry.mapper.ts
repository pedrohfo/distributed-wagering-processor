import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';

export class WalletLedgerEntryMapper {
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    if (!Object.values(LedgerDirection).includes(entity.direction as LedgerDirection)) {
      throw new Error(`Unknown ledger direction: ${entity.direction}`);
    }
    return WalletLedgerEntry.rehydrate({
      id: entity.id, walletId: entity.walletId, transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: { amount: entity.amount, currency: entity.currency },
      balanceBefore: { amount: entity.balanceBeforeAmount, currency: entity.currency },
      balanceAfter: { amount: entity.balanceAfterAmount, currency: entity.currency },
      createdAt: entity.createdAt,
    });
  }

  static toEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toJSON().amount;
    entity.currency = entry.money.currency;
    entity.balanceBeforeAmount = entry.balanceBefore.toJSON().amount;
    entity.balanceAfterAmount = entry.balanceAfter.toJSON().amount;
    entity.createdAt = entry.createdAt;
    return entity;
  }
}
