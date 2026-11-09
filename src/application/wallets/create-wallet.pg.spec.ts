import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../database/mikro-orm.config';
import { WalletEntity } from '../../database/entities/wallet.entity';
import { CreateWalletService } from './create-wallet.service';

// Explicit opt-in: NEVER run tests that persist immutable financial records on a shared DB.
const enabled = process.env.RUN_DB_INTEGRATION === '1';
const pgDescribe = enabled ? describe : describe.skip;

type DbRow = Record<string, unknown>;

pgDescribe('CreateWalletService — real PostgreSQL', () => {
  let orm: MikroORM;

  const query = async <T extends DbRow = DbRow>(sql: string, parameters: unknown[] = []): Promise<T[]> => {
    return orm.em.getConnection().execute<T[]>(sql, parameters);
  };

  const newPlayer = () => `pgtest-${randomUUID()}`;
  const service = () => new CreateWalletService(orm.em.fork());

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'backend_test') {
      throw new Error('Refusing PostgreSQL integration tests: DB_NAME must be backend_test');
    }
    orm = await MikroORM.init(ormConfig);
    // Cross-check the actual database, not only the .env setting.
    const rows = await query<{ database_name: string }>('select current_database() as database_name');
    if (rows[0]?.database_name !== 'backend_test') {
      await orm.close(true);
      throw new Error('Refusing PostgreSQL integration tests: connection is not to backend_test');
    }
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  it('atomically creates an opening wallet, processed transaction, CREDIT ledger, and two outbox events', async () => {
    const playerId = newPlayer();
    const wallet = await service().execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    const wallets = await query<{ balance: string; version: number }>(
      'select balance, version from wallets where id = ?', [wallet.id],
    );
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.balance).toBe('100.00');
    expect(wallets[0]?.version).toBe(1);

    const transactions = await query<{
      id: string; provider_id: string; kind: string; status: string;
      amount: string; round_id: string | null; game_id: string | null;
    }>(
      'select id, provider_id, kind, status, amount, round_id, game_id from wager_transactions where wallet_id = ?',
      [wallet.id],
    );
    expect(transactions).toHaveLength(1);
    const opening = transactions[0]!;
    expect(opening.provider_id).toBe('__internal__');
    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');
    expect(opening.amount).toBe('100.00');
    expect(opening.round_id).toBeNull();
    expect(opening.game_id).toBeNull();

    const entries = await query<{
      transaction_id: string; direction: string; amount: string;
      balance_before: string; balance_after: string;
    }>(
      'select transaction_id, direction, amount, balance_before, balance_after from wallet_ledger_entries where wallet_id = ?',
      [wallet.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transaction_id: opening.id,
      direction: 'CREDIT', amount: '100.00',
      balance_before: '0.00', balance_after: '100.00',
    });

    const events = await query<{ event_type: string; published_at: Date | null }>(
      'select event_type, published_at from outbox_messages where aggregate_id in (?, ?) order by event_type',
      [wallet.id, opening.id],
    );
    expect(events.map((event) => event.event_type).sort()).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ].sort());
    expect(events.every((event) => event.published_at === null)).toBe(true);
  });

  it('creates a zero-balance wallet without an opening transaction or ledger movement', async () => {
    const wallet = await service().execute({
      playerId: newPlayer(), initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(1);

    const tx = await query<{ count: string }>(
      'select count(*)::text as count from wager_transactions where wallet_id = ?', [wallet.id],
    );
    const ledger = await query<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where wallet_id = ?', [wallet.id],
    );
    const outbox = await query<{ count: string }>(
      'select count(*)::text as count from outbox_messages where aggregate_id = ?', [wallet.id],
    );
    expect(tx[0]?.count).toBe('0');
    expect(ledger[0]?.count).toBe('0');
    expect(outbox[0]?.count).toBe('0');
  });

  it('rejects duplicate player/currency and leaves no second financial operation', async () => {
    const playerId = newPlayer();
    const first = await service().execute({
      playerId, initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    await expect(service().execute({
      playerId, initialBalance: { amount: '20.00', currency: 'BRL' },
    })).rejects.toThrow();

    const wallets = await query<{ id: string; balance: string }>(
      'select id, balance from wallets where player_id = ? and currency = ?', [playerId, 'BRL'],
    );
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ id: first.id, balance: '10.00' });
    const tx = await query<{ count: string }>(
      'select count(*)::text as count from wager_transactions where wallet_id = ?', [first.id],
    );
    expect(tx[0]?.count).toBe('1');
  });

  it('rolls back an intentionally interrupted SQL transaction without leaving a wallet', async () => {
    const playerId = newPlayer();
    await expect(orm.em.fork().transactional(async (txEm) => {
      const wallet = new WalletEntity();
      wallet.id = randomUUID();
      wallet.playerId = playerId;
      wallet.currency = 'BRL';
      wallet.balanceAmount = '0.00';
      wallet.version = 1;
      wallet.createdAt = new Date();
      wallet.updatedAt = new Date();
      txEm.persist(wallet);
      await txEm.flush();
      throw new Error('intentional rollback');
    })).rejects.toThrow('intentional rollback');

    const rows = await query<{ count: string }>(
      'select count(*)::text as count from wallets where player_id = ?', [playerId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects modification and deletion of an existing ledger entry', async () => {
    const wallet = await service().execute({
      playerId: newPlayer(), initialBalance: { amount: '7.00', currency: 'BRL' },
    });
    const entries = await query<{ id: string }>(
      'select id from wallet_ledger_entries where wallet_id = ?', [wallet.id],
    );
    const entryId = entries[0]?.id;
    expect(entryId).toBeDefined();

    await expect(query(
      'update wallet_ledger_entries set amount = ? where id = ?', ['8.00', entryId],
    )).rejects.toThrow();
    await expect(query(
      'delete from wallet_ledger_entries where id = ?', [entryId],
    )).rejects.toThrow();

    const after = await query<{ amount: string; direction: string }>(
      'select amount, direction from wallet_ledger_entries where id = ?', [entryId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ amount: '7.00', direction: 'CREDIT' });
  });
});
