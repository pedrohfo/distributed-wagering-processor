import { EntityManager } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';

/** Append-only repository. Intentionally provides no update or delete operation. */
export class WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  insert(entry: WalletLedgerEntry): void {
    this.em.persist(WalletLedgerEntryMapper.toEntity(entry));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const entity = await this.em.findOne(WalletLedgerEntryEntity, { transactionId });
    return entity ? WalletLedgerEntryMapper.toDomain(entity) : null;
  }
}
