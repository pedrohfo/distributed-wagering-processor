import { createHash, randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message, type SQSClient,
} from '@aws-sdk/client-sqs';
import { InboxMessageEntity } from '../../database/entities/inbox-message.entity';
import { InboxMessageMapper } from '../../database/mappers/inbox-message.mapper';
import {
  IdempotencyConflictError, ProcessWagerService,
  type ProcessWagerCommand,
} from '../wagering/process-wager.service';
import { InvalidTransactionError, WagerTransactionKind } from '../../domain/wagering/wager-transaction';

export class InvalidSqsWagerMessageError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidSqsWagerMessageError'; }
}
export class InboxPayloadConflictError extends Error {
  constructor() { super('Same inbox message ID has a different message body'); this.name = 'InboxPayloadConflictError'; }
}

interface WagerRequestEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: ProcessWagerCommand;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const requiredString = (value: unknown, key: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidSqsWagerMessageError(`${key} must be a nonempty string`);
  return value;
};

/** Strict wire boundary; no `as ProcessWagerCommand` cast for untrusted JSON. */
export function parseWagerRequest(body: string): WagerRequestEnvelope {
  let input: unknown;
  try { input = JSON.parse(body) as unknown; }
  catch { throw new InvalidSqsWagerMessageError('Invalid JSON body'); }
  if (!object(input) || input.type !== 'WagerTransactionRequested' || !object(input.data)) {
    throw new InvalidSqsWagerMessageError('Expected WagerTransactionRequested envelope');
  }
  const messageId = requiredString(input.messageId, 'messageId');
  const occurredAt = requiredString(input.occurredAt, 'occurredAt');
  if (!Number.isFinite(Date.parse(occurredAt))) throw new InvalidSqsWagerMessageError('Invalid occurredAt');
  const data = input.data;
  if (!object(data.money)) throw new InvalidSqsWagerMessageError('Invalid money');
  const rawKind = requiredString(data.kind, 'kind');
  const permittedKinds = [
    WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
    WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
  ] as const;
  if (!(permittedKinds as readonly string[]).includes(rawKind)) {
    throw new InvalidSqsWagerMessageError('Unsupported external wager kind');
  }
  if (data.referenceExternalTransactionId != null &&
      (typeof data.referenceExternalTransactionId !== 'string' || !data.referenceExternalTransactionId.trim())) {
    throw new InvalidSqsWagerMessageError('Invalid referenceExternalTransactionId');
  }
  const command: ProcessWagerCommand = {
    idempotencyKey: requiredString(data.idempotencyKey, 'idempotencyKey'),
    providerId: requiredString(data.providerId, 'providerId'),
    externalTransactionId: requiredString(data.externalTransactionId, 'externalTransactionId'),
    walletId: requiredString(data.walletId, 'walletId'),
    playerId: requiredString(data.playerId, 'playerId'),
    roundId: requiredString(data.roundId, 'roundId'),
    gameId: requiredString(data.gameId, 'gameId'),
    kind: rawKind as ProcessWagerCommand['kind'],
    money: {
      amount: requiredString(data.money.amount, 'money.amount'),
      currency: requiredString(data.money.currency, 'money.currency'),
    },
    ...(data.referenceExternalTransactionId != null
      ? { referenceExternalTransactionId: data.referenceExternalTransactionId as string } : {}),
  };
  return { messageId, type: 'WagerTransactionRequested', occurredAt, data: command };
}

export interface InboxConsumerResult {
  received: number;
  acknowledged: number;
  duplicated: number;
  businessRejected: number;
  retriableFailures: number;
  deadLettered: number;
}

export interface SqsInboxConsumerOptions {
  consumerName?: string;
  /** Must be a different FIFO queue from the incoming wager queue. */
  deadLetterQueueUrl: string;
  /** Test/fault-injection hook: invoked after financial writes, before outer COMMIT. */
  afterWagerBeforeCommit?: () => Promise<void>;
  /** Test/fault injection: fail after database commit but before SQS delete. */
  beforeAck?: () => Promise<void>;
  /** Do not issue further ReceiveMessage calls after signal is aborted. */
  signal?: AbortSignal;
}

/**
 * Receive -> database transaction (inbox + financial operation) -> commit -> SQS delete.
 * ACK failure is safe: redelivery sees a committed inbox row and ACKs without a new wager.
 * Unexpected errors are intentionally not ACKed; SQS visibility timeout/redrive handles retry.
 */
export class SqsInboxConsumerService {
  private readonly consumerName: string;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: Pick<SQSClient, 'send'>,
    private readonly queueUrl: string,
    private readonly options: SqsInboxConsumerOptions,
  ) {
    if (!queueUrl.endsWith('.fifo') || !options.deadLetterQueueUrl.endsWith('.fifo')) {
      throw new Error('Both input and DLQ must be FIFO queue URLs');
    }
    if (queueUrl === options.deadLetterQueueUrl) throw new Error('DLQ must differ from input queue');
    this.consumerName = options.consumerName ?? 'wager-transactions-consumer-v1';
    if (!this.consumerName.trim()) throw new Error('consumerName is required');
  }

  async runOnce(maxMessages = 10, waitTimeSeconds = 0): Promise<InboxConsumerResult> {
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10) throw new Error('maxMessages must be 1..10');
    if (!Number.isInteger(waitTimeSeconds) || waitTimeSeconds < 0 || waitTimeSeconds > 20) {
      throw new Error('waitTimeSeconds must be 0..20');
    }
    const result: InboxConsumerResult = {
      received: 0, acknowledged: 0, duplicated: 0,
      businessRejected: 0, retriableFailures: 0, deadLettered: 0,
    };
    if (this.options.signal?.aborted) return result;
    const batch = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitTimeSeconds,
      MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
    }));
    for (const message of batch.Messages ?? []) {
      if (this.options.signal?.aborted) break;
      result.received++;
      if (!message.ReceiptHandle || typeof message.Body !== 'string') {
        result.retriableFailures++;
        continue;
      }
      try {
        const outcome = await this.consumeOne(message.Body);
        // Only reached after PostgreSQL COMMIT has returned successfully.
        await this.options.beforeAck?.();
        await this.ack(message.ReceiptHandle);
        result.acknowledged++;
        if (outcome === 'duplicate') result.duplicated++;
        if (outcome === 'business-rejected') result.businessRejected++;
      } catch (error) {
        if (error instanceof InvalidSqsWagerMessageError || error instanceof InboxPayloadConflictError) {
          try {
            await this.sendToDlq(message, error);
            await this.ack(message.ReceiptHandle);
            result.deadLettered++;
            result.acknowledged++;
          } catch (transportError) {
            result.retriableFailures++;
            console.error('Failed DLQ transfer or ACK; leaving SQS message for redelivery', transportError);
          }
        } else {
          // Could also be ACK failure AFTER a successful commit; replay is safe.
          result.retriableFailures++;
          console.warn('SQS wager handling failed; leaving for redelivery', error);
        }
      }
    }
    return result;
  }

  private async consumeOne(body: string): Promise<'processed' | 'duplicate' | 'business-rejected'> {
    const envelope = parseWagerRequest(body);
    const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex');
    return this.em.transactional(async (txEm) => {
      // Unique insert is the concurrency claim. Competing transactions wait for the
      // first commit, then ON CONFLICT does nothing; no double financial effect.
      const inserted = await txEm.execute<Array<{ consumer_name: string }>>(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, now())
         ON CONFLICT (consumer_name, message_id) DO NOTHING
         RETURNING consumer_name`,
        [this.consumerName, envelope.messageId, payloadHash], 'all',
      );
      if (inserted.length === 0) {
        const existing = await txEm.findOneOrFail(InboxMessageEntity, {
          consumerName: this.consumerName, messageId: envelope.messageId,
        });
        if (existing.payloadHash !== payloadHash) throw new InboxPayloadConflictError();
        if (!existing.processedAt) throw new Error('Unprocessed inbox row: investigate/retry');
        return 'duplicate';
      }

      // ProcessWagerService uses a nested transactional EM/savepoint. The outer
      // transaction here still owns the final COMMIT and the inbox receipt.
      let businessRejected = false;
      try {
        await new ProcessWagerService(txEm).execute(envelope.data);
      } catch (error) {
        if (error instanceof IdempotencyConflictError || error instanceof InvalidTransactionError) {
          businessRejected = true; // terminal business error, no financial mutation
        } else {
          throw error;
        }
      }
      await this.options.afterWagerBeforeCommit?.();
      const entity = await txEm.findOneOrFail(InboxMessageEntity, {
        consumerName: this.consumerName, messageId: envelope.messageId,
      });
      const message = InboxMessageMapper.toDomain(entity);
      message.markProcessed(new Date());
      InboxMessageMapper.updateEntity(entity, message);
      await txEm.flush();
      return businessRejected ? 'business-rejected' : 'processed';
    }, { clear: true });
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  private async sendToDlq(message: Message, error: Error): Promise<void> {
    await this.sqs.send(new SendMessageCommand({
      QueueUrl: this.options.deadLetterQueueUrl,
      MessageBody: message.Body ?? '',
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid-wager',
      MessageDeduplicationId: randomUUID(),
      MessageAttributes: {
        errorType: { DataType: 'String', StringValue: error.name },
        reason: { DataType: 'String', StringValue: error.message.slice(0, 256) },
      },
    }));
  }
}
