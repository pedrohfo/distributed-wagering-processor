import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../database/mikro-orm.config';
import { CreateWalletService } from '../wallets/create-wallet.service';
import { ProcessWagerService, IdempotencyConflictError, type ProcessWagerCommand } from './process-wager.service';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../domain/wagering/wager-transaction';

// Uses the same dedicated DB and opt-in flag as Phase 4D.
const pgDescribe = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

pgDescribe('ProcessWagerService — PostgreSQL', () => {
  let orm: MikroORM;
  const sql = async <T extends Record<string, unknown>>(q: string, args: unknown[] = []) =>
    orm.em.getConnection().execute<T[]>(q, args);
  const newService = () => new ProcessWagerService(orm.em.fork());
  const setup = async (amount = '100.00') =>
    new CreateWalletService(orm.em.fork()).execute({
      playerId: `wager-pg-${randomUUID()}`,
      initialBalance: { amount, currency: 'BRL' },
    });
  const command = (
    wallet: { id: string; playerId: string },
    kind: ProcessWagerCommand['kind'],
    amount = '25.00',
    extra: Partial<ProcessWagerCommand> = {},
  ): ProcessWagerCommand => {
    const externalTransactionId = randomUUID();
    return {
      providerId: 'phase5a-test-provider', externalTransactionId,
      idempotencyKey: `phase5a-test-provider:${externalTransactionId}`,
      walletId: wallet.id, playerId: wallet.playerId,
      roundId: 'test-round', gameId: 'test-game', kind,
      money: { amount, currency: 'BRL' }, ...extra,
    };
  };

  beforeAll(async () => {
    if (globalThis.process.env.DB_NAME !== 'backend_test') {
      throw new Error('DB_NAME must be backend_test');
    }
    orm = await MikroORM.init(ormConfig);
    const rows = await sql<{ db: string }>('select current_database() as db');
    if (rows[0]?.db !== 'backend_test') {
      await orm.close(true);
      throw new Error('Refusing to write outside backend_test');
    }
  });
  afterAll(async () => { if (orm) await orm.close(true); });

  it('processes BET with one DEBIT ledger and two outbox events', async () => {
    const wallet = await setup();
    const result = await newService().execute(command(wallet, Kind.Bet));
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('75.00');
    const ledger = await sql<{ direction: string; amount: string }>(
      'select direction, amount from wallet_ledger_entries where transaction_id = ?', [result.transactionId]);
    expect(ledger).toEqual([{ direction: 'DEBIT', amount: '25.00' }]);
    const events = await sql<{ event_type: string }>(
      'select event_type from outbox_messages where aggregate_id in (?, ?)',
      [wallet.id, result.transactionId]);
    expect(events.filter(x => x.event_type === 'WagerTransactionProcessed')).toHaveLength(1);
    // WalletBalanceChanged is emitted for both opening and wager, check the wager's ledger via its event payload.
    const changed = await sql<{ payload: { data?: { transactionId?: string } } }>(
      "select payload from outbox_messages where event_type = 'WalletBalanceChanged' and aggregate_id = ?", [wallet.id]);
    expect(changed.filter(e => e.payload.data?.transactionId === result.transactionId)).toHaveLength(1);
  });

  it('replays the original observed balance, even after a later wager', async () => {
    const wallet = await setup();
    const firstCmd = command(wallet, Kind.Bet, '10.00');
    const first = await newService().execute(firstCmd);
    await newService().execute(command(wallet, Kind.Bet, '15.00'));
    const replay = await newService().execute(firstCmd);
    expect(replay).toMatchObject({ transactionId: first.transactionId,
      status: Status.Processed, balance: { amount: '90.00', currency: 'BRL' },
      idempotentReplay: true });
    const rows = await sql<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [first.transactionId]);
    expect(rows[0]?.count).toBe('1');
  });

  it('rejects reuse of the idempotency key with changed payload', async () => {
    const wallet = await setup();
    const original = command(wallet, Kind.Bet, '10.00');
    await newService().execute(original);
    await expect(newService().execute({ ...original, money: { amount: '11.00', currency: 'BRL' } }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('two simultaneous 80.00 BETs allow exactly one debit', async () => {
    const wallet = await setup('100.00');
    const [a, b] = await Promise.all([
      newService().execute(command(wallet, Kind.Bet, '80.00')),
      newService().execute(command(wallet, Kind.Bet, '80.00')),
    ]);
    expect([a.status, b.status].sort()).toEqual([Status.Processed, Status.Rejected].sort());
    const rejected = [a, b].find(x => x.status === Status.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.InsufficientFunds);
    const rows = await sql<{ balance: string; version: number }>(
      'select balance, version from wallets where id = ?', [wallet.id]);
    expect(rows[0]).toEqual({ balance: '20.00', version: 2 });
    const debits = await sql<{ count: string }>(
      "select count(*)::text as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [wallet.id]);
    expect(debits[0]?.count).toBe('1');
  });

  it('WIN credits, LOSS produces no ledger', async () => {
    const wallet = await setup();
    const win = await newService().execute(command(wallet, Kind.Win, '5.00'));
    const loss = await newService().execute(command(wallet, Kind.Loss, '5.00'));
    expect(win.balance.amount).toBe('105.00');
    expect(loss.balance.amount).toBe('105.00');
    const rows = await sql<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [loss.transactionId]);
    expect(rows[0]?.count).toBe('0');
  });

  it('REFUND of a processed BET credits once; second refund is rejected', async () => {
    const wallet = await setup();
    const betCommand = command(wallet, Kind.Bet, '30.00');
    await newService().execute(betCommand);
    const ref = { referenceExternalTransactionId: betCommand.externalTransactionId };
    const refund = await newService().execute(command(wallet, Kind.Refund, '30.00', ref));
    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance.amount).toBe('100.00');
    const duplicate = await newService().execute(command(wallet, Kind.Refund, '30.00', ref));
    expect(duplicate.status).toBe(Status.Rejected);
    expect(duplicate.failureCode).toBe(FailureCode.DuplicateReversal);
  });

  it('missing reference becomes durable PENDING_REFERENCE', async () => {
    const wallet = await setup();
    const pending = await newService().execute(command(wallet, Kind.Refund, '10.00', {
      referenceExternalTransactionId: `missing-${randomUUID()}`,
    }));
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.balance.amount).toBe('100.00');
    const rows = await sql<{ status: string; next_retry_at: Date | null }>(
      'select status, next_retry_at from wager_transactions where id = ?', [pending.transactionId]);
    expect(rows[0]?.status).toBe('PENDING_REFERENCE');
    expect(rows[0]?.next_retry_at).not.toBeNull();
  });

  it('ROLLBACK of a credited WIN rejects when balance is insufficient', async () => {
    const wallet = await setup('0.00');
    const winCommand = command(wallet, Kind.Win, '10.00');
    await newService().execute(winCommand);
    await newService().execute(command(wallet, Kind.Bet, '10.00'));
    const rollback = await newService().execute(command(wallet, Kind.Rollback, '10.00', {
      referenceExternalTransactionId: winCommand.externalTransactionId,
    }));
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rollback.balance.amount).toBe('0.00');
  });
});
