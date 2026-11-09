import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand,
  SendMessageCommand, type SQSClient,
} from '@aws-sdk/client-sqs';
import ormConfig from '../../database/mikro-orm.config';
import { CreateWalletService } from '../wallets/create-wallet.service';
import { SqsInboxConsumerService } from './sqs-inbox-consumer.service';
import { newSqsClient, sqsSettingsFromEnv } from '../../infrastructure/sqs/sqs-settings';

const pgDescribe = process.env.RUN_SQS_INTEGRATION === '1' ? describe : describe.skip;

pgDescribe('SqsInboxConsumerService — PostgreSQL + LocalStack', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  const queues: string[] = [];

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'backend_sqs_test') throw new Error('DB_NAME must be backend_sqs_test');
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):4566$/.test(process.env.SQS_ENDPOINT ?? '')) {
      throw new Error('SQS_ENDPOINT must be local LocalStack port 4566');
    }
    orm = await MikroORM.init(ormConfig);
    const rows = await orm.em.execute<Array<{ db: string }>>('select current_database() as db');
    if (rows[0]?.db !== 'backend_sqs_test') {
      await orm.close(true);
      throw new Error('Refusing writes outside backend_sqs_test');
    }
    sqs = newSqsClient(sqsSettingsFromEnv());
  });
  afterAll(async () => {
    if (sqs) {
      for (const queueUrl of queues) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
      }
      sqs.destroy();
    }
    if (orm) await orm.close(true);
  });

  async function makeQueue(): Promise<string> {
    const name = `wager-inbox-test-${randomUUID().slice(0, 12)}.fifo`;
    const created = await sqs.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '1' },
    }));
    if (!created.QueueUrl) throw new Error('Test queue creation failed');
    queues.push(created.QueueUrl);
    return created.QueueUrl;
  }

  async function fixture() {
    const queueUrl = await makeQueue();
    const dlqUrl = await makeQueue();
    const wallet = await new CreateWalletService(orm.em.fork()).execute({
      playerId: `sqs-test-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const txId = randomUUID();
    const messageId = randomUUID();
    const body = JSON.stringify({
      messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: {
        providerId: 'sqs-provider', externalTransactionId: txId,
        idempotencyKey: `sqs-provider:${txId}`,
        walletId: wallet.id, playerId: wallet.playerId,
        roundId: 'round-1', gameId: 'game-1', kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
    const publish = async (payload = body) => {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl, MessageBody: payload,
        MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID(),
      }));
    };
    const consume = (options: { afterWagerBeforeCommit?: () => Promise<void>; beforeAck?: () => Promise<void> } = {}) =>
      new SqsInboxConsumerService(orm.em.fork(), sqs, queueUrl, {
        deadLetterQueueUrl: dlqUrl, ...options,
      });
    const sql = <T>(query: string, params: unknown[] = []) => orm.em.execute<T[]>(query, params);
    return { wallet, queueUrl, dlqUrl, messageId, body, publish, consume, sql };
  }

  it('atomically commits wager, inbox, ledger, outbox, then acknowledges SQS', async () => {
    const f = await fixture();
    await f.publish();
    const stats = await f.consume().runOnce(1);
    expect(stats).toMatchObject({ received: 1, acknowledged: 1, retriableFailures: 0 });
    const [inbox] = await f.sql<{ processed_at: Date | null }>(
      'select processed_at from inbox_messages where consumer_name = ? and message_id = ?',
      ['wager-transactions-consumer-v1', f.messageId],
    );
    const value = inbox?.processed_at;

    if (value == null) {
      throw new Error('Inbox processed_at must not be null');
    }

    const processedAt = new Date(value);

    expect(Number.isNaN(processedAt.getTime())).toBe(false);
    const [wallet] = await f.sql<{ balance: string }>('select balance from wallets where id = ?', [f.wallet.id]);
    expect(wallet?.balance).toBe('75.00');
    const [ledgers] = await f.sql<{ total: string }>(
      "select count(*)::text as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [f.wallet.id],
    );
    expect(ledgers?.total).toBe('1');
    // Events use wager ID as aggregate ID; check independently via the wager row below.
    const [wager] = await f.sql<{ id: string }>(
      "select id from wager_transactions where wallet_id = ? and kind = 'BET'", [f.wallet.id],
    );
    const [eventCount] = await f.sql<{ total: string }>(
      "select count(*)::text as total from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed'",
      [wager?.id],
    );
    expect(eventCount?.total).toBe('1');
    const redelivery = await f.consume().runOnce(1);
    expect(redelivery.received).toBe(0);
  });

  it('deduplicates two distinct SQS deliveries with the same envelope messageId', async () => {
    const f = await fixture();
    await f.publish();
    expect((await f.consume().runOnce(1)).acknowledged).toBe(1);
    await f.publish(); // Different SQS MessageId/dedup ID, same business message ID.
    expect(await f.consume().runOnce(1)).toMatchObject({ duplicated: 1, acknowledged: 1 });
    const [ledger] = await f.sql<{ total: string }>(
      "select count(*)::text as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [f.wallet.id],
    );
    expect(ledger?.total).toBe('1');
  });

  it('rolls back financial writes AND inbox on failure before COMMIT, then retries', async () => {
    const f = await fixture();
    await f.publish();
    const failing = f.consume({ afterWagerBeforeCommit: async () => { throw new Error('synthetic before-commit crash'); } });
    const first = await failing.runOnce(1);
    expect(first).toMatchObject({ received: 1, acknowledged: 0, retriableFailures: 1 });
    const [wallet] = await f.sql<{ balance: string }>('select balance from wallets where id = ?', [f.wallet.id]);
    expect(wallet?.balance).toBe('100.00');
    const [inbox] = await f.sql<{
      total: string | number;
    }>(
      'select count(*) as total from inbox_messages where consumer_name = ? and message_id = ?',
      ['wager-transactions-consumer-v1', f.messageId],
    );

    expect(Number(inbox?.total)).toBe(0);
    let second: Awaited<ReturnType<
      ReturnType<typeof f.consume>['runOnce']
    >> | undefined;

    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const result = await f.consume().runOnce(1);

      if (result.received > 0) {
        second = result;
        break;
      }

      await Bun.sleep(300);
    }

    expect(second).toBeDefined();
    expect(second).toMatchObject({
      received: 1,
      acknowledged: 1,
      retriableFailures: 0,
    });
    const [after] = await f.sql<{ balance: string }>('select balance from wallets where id = ?', [f.wallet.id]);
    expect(after?.balance).toBe('75.00');
  });

  it('survives crash after COMMIT but before ACK; redelivery has no double debit', async () => {
    const f = await fixture();
    await f.publish();
    const crash = f.consume({ beforeAck: async () => { throw new Error('synthetic post-commit crash'); } });
    expect(await crash.runOnce(1)).toMatchObject({ received: 1, acknowledged: 0, retriableFailures: 1 });
    const [first] = await f.sql<{ balance: string }>('select balance from wallets where id = ?', [f.wallet.id]);
    expect(first?.balance).toBe('75.00');
    let redelivery:
      | Awaited<ReturnType<ReturnType<typeof f.consume>['runOnce']>>
      | undefined;

    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const result = await f.consume().runOnce(1);

      if (result.received > 0) {
        redelivery = result;
        break;
      }

      await Bun.sleep(300);
    }

    expect(redelivery).toBeDefined();
    expect(redelivery).toMatchObject({
      received: 1,
      duplicated: 1,
      acknowledged: 1,
      retriableFailures: 0,
    });
    const [afterRedelivery] = await f.sql<{ balance: string }>(
      'select balance from wallets where id = ?',
      [f.wallet.id],
    );

    expect(afterRedelivery?.balance).toBe('75.00');
    const [ledger] = await f.sql<{ total: string }>(
      "select count(*)::text as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
      [f.wallet.id],
    );
    expect(ledger?.total).toBe('1');
  });

  it('moves invalid JSON to FIFO DLQ before removing original SQS message', async () => {
    const f = await fixture();
    await f.publish('{not-json');
    expect(await f.consume().runOnce(1)).toMatchObject({ deadLettered: 1, acknowledged: 1 });
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: f.dlqUrl, WaitTimeSeconds: 1 }));
    expect(received.Messages?.[0]?.Body).toBe('{not-json');
    const after = await f.consume().runOnce(1);
    expect(after.received).toBe(0);
  });
});
