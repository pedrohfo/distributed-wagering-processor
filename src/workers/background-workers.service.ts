import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from '../database/mikro-orm.config';
import { OutboxPublisherService } from '../application/messaging/outbox-publisher.service';
import { SqsInboxConsumerService } from '../application/messaging/sqs-inbox-consumer.service';
import { PendingReferenceWorkerService } from '../application/wagering/pending-reference-worker.service';
import { newSqsClient, sqsSettingsFromEnv } from '../infrastructure/sqs/sqs-settings';
import { WorkerLoop } from './worker-loop';
import { readWorkerSettings, type WorkerSettings } from './worker-settings';

type LogFields = Record<string, string | number | boolean | null>;

/** Structured operational log; never log wager message bodies or credentials. */
const log = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, component: 'background-workers', event, ...fields }));
};

/**
 * A Nest application-context host for the three independent pollers.
 * Each cycle receives a NEW MikroORM fork (no cross-loop identity map).
 * SIGTERM stops new cycles, then waits for in-flight work before closing resources.
 */
@Injectable()
export class BackgroundWorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private orm?: MikroORM;
  private sqs?: SQSClient;
  private loops: WorkerLoop[] = [];
  private initialized = false;
  private readonly settings: WorkerSettings = readWorkerSettings(process.env);

  async onApplicationBootstrap(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.settings.enabled) {
      log('info', 'workers_disabled');
      return;
    }
    try {
      this.orm = await MikroORM.init(ormConfig);
      await this.orm.em.getConnection().execute('select 1');
      this.sqs = newSqsClient(sqsSettingsFromEnv());
      // Fail fast on incorrect queue URLs rather than silently polling forever.
      for (const queueUrl of [
        this.settings.inboxQueueUrl, this.settings.inboxDlqUrl, this.settings.outboxQueueUrl,
      ]) {
        await this.sqs.send(new GetQueueAttributesCommand({
          QueueUrl: queueUrl, AttributeNames: ['QueueArn'],
        }));
      }
      const orm = this.orm;
      const sqs = this.sqs;
      const options = this.settings;
      this.loops = [
        new WorkerLoop('sqs-inbox', options.inboxIntervalMs, async () => {
          const stats = await new SqsInboxConsumerService(
            orm.em.fork(), sqs, options.inboxQueueUrl,
            { deadLetterQueueUrl: options.inboxDlqUrl },
          ).runOnce(options.inboxBatchSize, options.inboxWaitSeconds);
          if (stats.received > 0) log('info', 'inbox_cycle', { ...stats });
        }, (error) => this.logError('sqs-inbox', error)),
        new WorkerLoop('outbox', options.outboxIntervalMs, async () => {
          const stats = await new OutboxPublisherService(
            orm.em.fork(), sqs, options.outboxQueueUrl,
          ).runOnce(options.outboxBatchSize);
          if (stats.published > 0 || stats.retried > 0) log('info', 'outbox_cycle', { ...stats });
        }, (error) => this.logError('outbox', error)),
        new WorkerLoop('pending-reference', options.referenceIntervalMs, async () => {
          const stats = await new PendingReferenceWorkerService(orm.em.fork())
            .runOnce({ limit: options.referenceBatchSize });
          if (stats.claimed > 0) log('info', 'reference_cycle', { ...stats });
        }, (error) => this.logError('pending-reference', error)),
      ];
      for (const loop of this.loops) loop.start();
      log('info', 'workers_started', { pollers: this.loops.length });
    } catch (error) {
      await this.closeResources();
      this.initialized = false;
      throw error;
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    log('info', 'workers_stopping', { signal: signal ?? 'application-close' });
    // stop() interrupts idle timers and awaits currently executing polling cycles.
    await Promise.all(this.loops.map((loop) => loop.stop()));
    await this.closeResources();
    log('info', 'workers_stopped');
  }

  private logError(worker: string, error: unknown): void {
    // Report the exception class rather than raw SQL or financial payloads.
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    log('error', 'worker_cycle_failed', { worker, errorType });
  }

  private async closeResources(): Promise<void> {
    const orm = this.orm;
    const sqs = this.sqs;
    this.orm = undefined;
    this.sqs = undefined;
    sqs?.destroy();
    if (orm) await orm.close(true);
  }
}
