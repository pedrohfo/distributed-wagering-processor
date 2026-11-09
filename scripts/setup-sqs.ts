import {
  CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand,
  SetQueueAttributesCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { newSqsClient, sqsSettingsFromEnv } from '../src/infrastructure/sqs/sqs-settings';

const DLQ = 'wager-transactions-dlq.fifo';
const MAIN = 'wager-transactions.fifo';
const EVENTS = 'wager-events.fifo';
const EVENTS_DLQ = 'wager-events-dlq.fifo';
const client: SQSClient = newSqsClient(sqsSettingsFromEnv());

async function ensureQueue(name: string, attributes: Record<string, string>): Promise<string> {
  let url: string;
  try {
    const found = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!found.QueueUrl) throw new Error(`Missing URL for ${name}`);
    url = found.QueueUrl;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'QueueDoesNotExist') throw error;
    const created = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    if (!created.QueueUrl) throw new Error(`Missing URL for ${name}`);
    url = created.QueueUrl;
  }
  // FifoQueue is creation-only; update only mutable attributes on existing queues.
  const { FifoQueue: _fifoQueue, ...mutableAttributes } = attributes;
  if (Object.keys(mutableAttributes).length > 0) {
    await client.send(new SetQueueAttributesCommand({
      QueueUrl: url, Attributes: mutableAttributes,
    }));
  }
  return url;
}

async function getQueueArn(url: string): Promise<string> {
  const result = await client.send(new GetQueueAttributesCommand({
    QueueUrl: url, AttributeNames: ['QueueArn'],
  }));
  const arn = result.Attributes?.QueueArn;
  if (!arn) throw new Error(`QueueArn missing for ${url}`);
  return arn;
}

async function main(): Promise<void> {
  try {
    const dlqUrl = await ensureQueue(DLQ, {
      FifoQueue: 'true', ContentBasedDeduplication: 'false',
      MessageRetentionPeriod: '1209600',
    });
    const dlqArn = await getQueueArn(dlqUrl);
    const queueUrl = await ensureQueue(MAIN, {
      FifoQueue: 'true', ContentBasedDeduplication: 'false',
      VisibilityTimeout: '60', ReceiveMessageWaitTimeSeconds: '10',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
    });
    const eventsDlqUrl = await ensureQueue(EVENTS_DLQ, {
      FifoQueue: 'true', ContentBasedDeduplication: 'false',
      MessageRetentionPeriod: '1209600',
    });
    const eventsDlqArn = await getQueueArn(eventsDlqUrl);
    const eventsQueueUrl = await ensureQueue(EVENTS, {
      FifoQueue: 'true', ContentBasedDeduplication: 'false',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: eventsDlqArn, maxReceiveCount: 5 }),
    });
    console.info(JSON.stringify({ queueUrl, dlqUrl, eventsQueueUrl, eventsDlqUrl }, null, 2));
  } finally {
    client.destroy();
  }
}

// No top-level await, compatible with the project's NodeNext TS configuration.
void main().catch((error: unknown) => {
  console.error('SQS setup failed:', error);
  process.exitCode = 1;
});
