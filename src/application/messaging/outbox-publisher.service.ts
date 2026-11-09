import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessageEntity } from '../../database/entities/outbox-message.entity';
import { OutboxMessageMapper } from '../../database/mappers/outbox-message.mapper';

/** Every event is sent at least once. Consumers MUST deduplicate the eventId. */
export class OutboxPublisherService {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
  ) {
    if (!queueUrl) throw new Error('An SQS FIFO queue URL is required');
    if (!queueUrl.endsWith('.fifo')) throw new Error('Outbox destination must be an SQS FIFO queue');
  }

  /**
   * Finds one eligible row per transaction. A row lock is retained until
   * send succeeds/fails and its publication state commits. Two concurrent
   * workers skip each other's claims. If the process crashes after SendMessage
   * and before COMMIT the event may be sent again; the eventId stays stable.
   */
  async runOnce(maxMessages = 10, now = new Date()): Promise<{ published: number; retried: number }> {
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
      throw new Error('maxMessages must be between 1 and 100');
    }
    let published = 0;
    let retried = 0;
    for (let i = 0; i < maxMessages; i++) {
      const result = await this.em.transactional(async (txEm): Promise<'empty' | 'published' | 'retried'> => {
        const [entity] = await txEm.find(OutboxMessageEntity, {
          publishedAt: null,
          $or: [
            { nextAttemptAt: { $lte: now } },
            { nextAttemptAt: null, occurredAt: { $lte: now } },
          ],
        }, {
          orderBy: { occurredAt: 'asc', id: 'asc' },
          limit: 1,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        });
        if (!entity) return 'empty';
        const message = OutboxMessageMapper.toDomain(entity);
        const envelope = message.payload;
        if (typeof envelope.eventId !== 'string' || envelope.eventId !== message.id) {
          // An invalid stored event must not be silently dropped.
          throw new Error(`Outbox ${message.id} has invalid eventId`);
        }
        try {
          await this.sqs.send(new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(envelope),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          }));
          message.markPublished(now);
          OutboxMessageMapper.updateState(entity, message);
          await txEm.flush();
          return 'published';
        } catch (error) {
          // Transport errors are retried; preserve the unsent outbox row.
          message.scheduleRetry(now);
          OutboxMessageMapper.updateState(entity, message);
          await txEm.flush();
          console.warn('Outbox publish failed; retry scheduled', {
            outboxId: entity.id,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : String(error),
          });
          return 'retried';
        }
      });
      if (result === 'empty') break;
      if (result === 'published') published += 1;
      else retried += 1;
    }
    return { published, retried };
  }
}
