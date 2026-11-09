import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand, DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from '../../database/mikro-orm.config';
import { OutboxMessageEntity } from '../../database/entities/outbox-message.entity';
import { OutboxPublisherService } from './outbox-publisher.service';
import { newSqsClient, sqsSettingsFromEnv } from '../../infrastructure/sqs/sqs-settings';

const enabled = process.env.RUN_SQS_INTEGRATION === '1';
const describeDb = enabled ? describe : describe.skip;

describeDb('OutboxPublisherService — real PostgreSQL and LocalStack', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queueUrl: string;

  beforeAll(async () => {
    if (process.env.DB_NAME !== 'backend_sqs_test') throw new Error('Refusing database other than backend_sqs_test');
    if (!process.env.SQS_ENDPOINT?.includes('localhost') && !process.env.SQS_ENDPOINT?.includes('127.0.0.1')) {
      throw new Error('Tests require local SQS_ENDPOINT');
    }
    queueUrl = process.env.SQS_OUTBOX_QUEUE_URL ?? '';
    if (!queueUrl.endsWith('.fifo')) throw new Error('Set SQS_OUTBOX_QUEUE_URL');
    orm = await MikroORM.init(ormConfig);
    const db = await orm.em.getConnection().execute<{ db: string }[]>('select current_database() as db');
    if (db[0]?.db !== 'backend_sqs_test') throw new Error('Wrong connected database');
    // Remove only synthetic test fixtures from earlier attempts; never touch financial outbox rows.
    await orm.em.fork().nativeDelete(OutboxMessageEntity, { eventType: 'TestEvent' });
    sqs = newSqsClient(sqsSettingsFromEnv());
  });
  afterAll(async () => {
    if (orm) {
      await orm.em.fork().nativeDelete(OutboxMessageEntity, { eventType: 'TestEvent' });
      await orm.close(true);
    }
    sqs?.destroy();
  });

  async function seedOutbox(id: string, group: string): Promise<void> {
    const em = orm.em.fork();
    const entity = new OutboxMessageEntity();
    entity.id = id;
    entity.aggregateId = group;
    entity.eventType = 'TestEvent';
    entity.payload = { eventId: id, eventType: 'TestEvent', aggregateId: group, occurredAt: new Date(0).toISOString(), version: 1, data: {} };
    entity.occurredAt = new Date(0);
    entity.attempts = 0;
    em.persist(entity);
    await em.flush();
  }

  it('publishes once, persists publishedAt, and does not send again on next poll', async () => {
    const id = randomUUID();
    const group = randomUUID();
    await seedOutbox(id, group);
    const publisher = new OutboxPublisherService(orm.em.fork(), sqs, queueUrl);
    // Shared test queue can include messages from other tests; assert by returned ID.
    const first = await publisher.runOnce(1, new Date('2000-01-01T00:00:00.000Z'));
    expect(first.published).toBe(1);
    const entity = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id });
    expect(entity.publishedAt).toBeInstanceOf(Date);
    const delivered = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2, MaxNumberOfMessages: 10 }));
    const matching = delivered.Messages?.filter((m) => {
      try { return (JSON.parse(m.Body ?? '{}') as { eventId?: string }).eventId === id; } catch { return false; }
    }) ?? [];
    expect(matching).toHaveLength(1);
    for (const m of matching) if (m.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
    const second = await publisher.runOnce(1, new Date('2000-01-01T00:00:00.000Z'));
    expect(second.published).toBe(0);
  });

  it('schedules a retry without marking published when SQS fails', async () => {
    const id = randomUUID();
    const group = randomUUID();
    await seedOutbox(id, group);
    const failing = { send: async (_command: unknown): Promise<never> => { throw new Error('synthetic outage'); } };
    const publisher = new OutboxPublisherService(orm.em.fork(), failing as unknown as SQSClient, queueUrl);
    const now = new Date('2000-01-01T00:00:00.000Z');
    const result = await publisher.runOnce(1, now);
    expect(result.retried).toBe(1);
    const entity = await orm.em.fork().findOneOrFail(OutboxMessageEntity, { id });
    expect(entity.attempts).toBe(1);
    expect(entity.publishedAt).toBeNull();
    expect(entity.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
  });
});
