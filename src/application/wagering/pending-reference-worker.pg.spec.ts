import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../database/mikro-orm.config';
import { CreateWalletService } from '../wallets/create-wallet.service';
import { ProcessWagerService, type ProcessWagerCommand } from './process-wager.service';
import { PendingReferenceWorkerService, nextReferenceRetry } from './pending-reference-worker.service';
import { FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../domain/wagering/wager-transaction';

const pgDescribe = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const providerId = 'phase5b-test-provider';

// Tests append their own wallet/transaction rows; they never delete or truncate ledger rows.
pgDescribe('PendingReferenceWorkerService — real PostgreSQL', () => {
  let orm: MikroORM;
  const query = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    orm.em.getConnection().execute<T[]>(sql, values);
  const wallet = async (amount = '100.00') =>
    new CreateWalletService(orm.em.fork()).execute({
      playerId: `recovery-${randomUUID()}`, initialBalance: { amount, currency: 'BRL' },
    });
  const command = (
    target: { id: string; playerId: string }, kind: ProcessWagerCommand['kind'],
    amount: string, externalTransactionId = randomUUID(), extra: Partial<ProcessWagerCommand> = {},
  ): ProcessWagerCommand => ({
    providerId, externalTransactionId, idempotencyKey: `${providerId}:${externalTransactionId}`,
    walletId: target.id, playerId: target.playerId, roundId: 'round-5b', gameId: 'game-5b',
    kind, money: { amount, currency: 'BRL' }, ...extra,
  });
  const process = (cmd: ProcessWagerCommand) => new ProcessWagerService(orm.em.fork()).execute(cmd);
  const worker = (options: ConstructorParameters<typeof PendingReferenceWorkerService>[1] = {}) =>
    new PendingReferenceWorkerService(orm.em.fork(), options);
  const one = async (id: string) => {
    const rows = await query<{
      status: string; failure_code: string | null; retry_attempts: number;
      next_retry_at: Date | null; observed_balance: string | null; reference_transaction_id: string | null;
    }>('select status, failure_code, retry_attempts, next_retry_at, observed_balance, reference_transaction_id from wager_transactions where id = ?', [id]);
    if (!rows[0]) throw new Error('Missing transaction');
    return rows[0];
  };
  const dueAt = () => {
    const future = new Date(Date.now() + 2000);
    // A deterministic worker clock avoids sleeps. It is allowed to be ahead of DB wall time.
    return future;
  };

  beforeAll(async () => {
    if (globalThis.process.env.DB_NAME !== 'backend_test') {
      throw new Error('Refusing to run outside backend_test');
    }
    orm = await MikroORM.init(ormConfig);
    const rows = await query<{ db: string }>('select current_database() as db');
    if (rows[0]?.db !== 'backend_test') {
      await orm.close(true);
      throw new Error('Refusing to write outside backend_test');
    }
  });
  afterAll(async () => { if (orm) await orm.close(true); });

  it('reschedules unresolved references with durable backoff and no ledger', async () => {
    const w = await wallet();
    const pending = await process(command(w, Kind.Refund, '10.00', randomUUID(), {
      referenceExternalTransactionId: `not-yet-${randomUUID()}`,
    }));
    expect(pending.status).toBe(Status.PendingReference);
    const result = await worker().runOnce({ now: dueAt(), limit: 1, transactionId: pending.transactionId });
    expect(result).toEqual({ claimed: 1, processed: 0, rejected: 0, rescheduled: 1 });
    const stored = await one(pending.transactionId);
    expect(stored.retry_attempts).toBe(1);
    expect(stored.next_retry_at).not.toBeNull();
    expect(stored.status).toBe(Status.PendingReference);
    const ledger = await query<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [pending.transactionId]);
    expect(ledger[0]?.count).toBe('0');
  });

  it('processes a late REFUND once and publishes outbox records', async () => {
    const w = await wallet();
    const external = randomUUID();
    const pending = await process(command(w, Kind.Refund, '30.00', randomUUID(), {
      referenceExternalTransactionId: external,
    }));
    expect(pending.status).toBe(Status.PendingReference);
    const bet = await process(command(w, Kind.Bet, '30.00', external));
    expect(bet.status).toBe(Status.Processed);
    const now = dueAt();
    const result = await worker().runOnce({ now, limit: 1, transactionId: pending.transactionId });
    expect(result.processed).toBe(1);
    const stored = await one(pending.transactionId);
    expect(stored.status).toBe(Status.Processed);
    expect(stored.reference_transaction_id).toBe(bet.transactionId);
    expect(stored.observed_balance).toBe('100.00');
    expect(stored.next_retry_at).toBeNull();
    const ledger = await query<{ direction: string }>(
      'select direction from wallet_ledger_entries where transaction_id = ?', [pending.transactionId]);
    expect(ledger).toEqual([{ direction: 'CREDIT' }]);
    const events = await query<{ event_type: string }>(
      "select event_type from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed'",
      [pending.transactionId]);
    expect(events).toHaveLength(1);
    expect((await worker().runOnce({ now, limit: 2, transactionId: pending.transactionId })).claimed).toBe(0);
  });

  it('rejects an invalid late reference and emits no ledger movement', async () => {
    const w = await wallet();
    const external = randomUUID();
    const pending = await process(command(w, Kind.Refund, '25.00', randomUUID(), {
      referenceExternalTransactionId: external,
    }));
    // A refund can only reference a processed BET; a WIN reference is invalid.
    await process(command(w, Kind.Win, '25.00', external));
    const result = await worker().runOnce({ now: dueAt(), limit: 1, transactionId: pending.transactionId });
    expect(result.rejected).toBe(1);
    const stored = await one(pending.transactionId);
    expect(stored.status).toBe(Status.Rejected);
    expect(stored.failure_code).toBe(FailureCode.InvalidReference);
    const ledger = await query<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [pending.transactionId]);
    expect(ledger[0]?.count).toBe('0');
  });

  it('rejects after retry budget and clears the retry schedule', async () => {
    const w = await wallet();
    const pending = await process(command(w, Kind.Refund, '10.00', randomUUID(), {
      referenceExternalTransactionId: randomUUID(),
    }));
    const now = dueAt();
    const result = await worker({ maxAttempts: 1 }).runOnce({ now, limit: 1, transactionId: pending.transactionId });
    expect(result.rejected).toBe(1);
    const stored = await one(pending.transactionId);
    expect(stored.status).toBe(Status.Rejected);
    expect(stored.failure_code).toBe(FailureCode.ReferenceNotFound);
    expect(stored.next_retry_at).toBeNull();
  });

  it('expires pending work after TTL even when reference is still missing', async () => {
    const w = await wallet();
    const pending = await process(command(w, Kind.Rollback, '10.00', randomUUID(), {
      referenceExternalTransactionId: randomUUID(),
    }));
    const now = new Date(Date.now() + 20_000);
    const result = await worker({ ttlMs: 5_000 }).runOnce({ now, limit: 1, transactionId: pending.transactionId });
    expect(result.rejected).toBe(1);
    expect((await one(pending.transactionId)).failure_code).toBe(FailureCode.ReferenceNotFound);
  });

  it('two competing workers claim one pending transaction at most once', async () => {
    const w = await wallet();
    const pending = await process(command(w, Kind.Refund, '10.00', randomUUID(), {
      referenceExternalTransactionId: randomUUID(),
    }));
    const now = dueAt();
    const [a, b] = await Promise.all([
      worker().runOnce({ now, limit: 1, transactionId: pending.transactionId }),
      worker().runOnce({ now, limit: 1, transactionId: pending.transactionId }),
    ]);
    expect(a.claimed + b.claimed).toBe(1);
    expect((await one(pending.transactionId)).retry_attempts).toBe(1);
  });
});

describe('Pending-reference retry scheduling', () => {
  it('caps exponential delay to TTL and maximum delay', () => {
    const cfg = { ttlMs: 10_000, maxAttempts: 12, baseDelayMs: 1_000, maxDelayMs: 4_000 };
    const createdAt = new Date('2026-01-01T00:00:00Z');
    expect(nextReferenceRetry(createdAt, createdAt, 1, cfg).toISOString())
      .toBe('2026-01-01T00:00:01.000Z');
    expect(nextReferenceRetry(createdAt, createdAt, 5, cfg).toISOString())
      .toBe('2026-01-01T00:00:04.000Z');
    expect(nextReferenceRetry(createdAt, new Date('2026-01-01T00:00:08Z'), 5, cfg).toISOString())
      .toBe('2026-01-01T00:00:10.000Z');
  });
});
