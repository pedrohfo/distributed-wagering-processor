import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from '../database/mikro-orm.config';
import { newSqsClient, sqsSettingsFromEnv } from '../infrastructure/sqs/sqs-settings';

/** One ORM connection pool per HTTP process. Fork EM for each request. */
@Injectable()
export class HttpResourcesService implements OnModuleInit, OnModuleDestroy {
  private orm?: MikroORM;
  private sqs?: SQSClient;

  async onModuleInit(): Promise<void> {
    this.orm = await MikroORM.init(ormConfig);
    this.sqs = newSqsClient(sqsSettingsFromEnv());
  }

  fork(): EntityManager {
    if (!this.orm) throw new Error('Database not initialized');
    return this.orm.em.fork();
  }

  async checkReady(): Promise<void> {
    if (!this.orm || !this.sqs) throw new Error('Dependencies not initialized');
    await this.orm.em.getConnection().execute('select 1');
    const queueUrls = [process.env.SQS_INBOX_QUEUE_URL, process.env.SQS_OUTBOX_QUEUE_URL];
    if (queueUrls.some((url) => !url?.endsWith('.fifo'))) {
      throw new Error('SQS queue URLs not configured');
    }
    for (const url of queueUrls) {
      await this.sqs.send(new GetQueueAttributesCommand({
        QueueUrl: url!, AttributeNames: ['QueueArn'],
      }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.sqs?.destroy();
    if (this.orm) await this.orm.close(true);
  }
}
