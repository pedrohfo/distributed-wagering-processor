import {
  CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { newSqsClient, sqsSettingsFromEnv } from '../src/infrastructure/sqs/sqs-settings';

const DLQ = 'wager-transactions-dlq.fifo';
const MAIN = 'wager-transactions.fifo';
const EVENTS = 'wager-events.fifo';
const EVENTS_DLQ = 'wager-events-dlq.fifo';
const client: SQSClient = newSqsClient(sqsSettingsFromEnv());

async function ensureQueue(name: string, attributes: Record<string, string>): Promise<string> {
  try {
    const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`Missing URL for ${name}`);
    return result.QueueUrl;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'QueueDoesNotExist') throw error;
    const created = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    if (!created.QueueUrl) throw new Error(`Missing created URL for ${name}`);
    return created.QueueUrl;
  }
}

async function main(): Promise<void> {
  const dlqUrl = await ensureQueue(DLQ, {
    FifoQueue: 'true', ContentBasedDeduplication: 'false',
    MessageRetentionPeriod: '1209600',
  });
  const attributes = await client.send(new GetQueueAttributesCommand({
    QueueUrl: dlqUrl, AttributeNames: ['QueueArn'],
  }));
  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ ARN not returned');
  const queueUrl = await ensureQueue(MAIN, {
    FifoQueue: 'true', ContentBasedDeduplication: 'false',
    VisibilityTimeout: '60', ReceiveMessageWaitTimeSeconds: '10',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
  });
  const eventsDlqUrl = await ensureQueue(EVENTS_DLQ, {
    FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600',
  });
  const eventAttrs = await client.send(new GetQueueAttributesCommand({
    QueueUrl: eventsDlqUrl, AttributeNames: ['QueueArn'],
  }));
  const eventsDlqArn = eventAttrs.Attributes?.QueueArn;
  if (!eventsDlqArn) throw new Error('Events DLQ ARN not returned');
  const eventsQueueUrl = await ensureQueue(EVENTS, {
    FifoQueue: 'true', ContentBasedDeduplication: 'false',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: eventsDlqArn, maxReceiveCount: 5 }),
  });
  console.info(JSON.stringify({ queueUrl, dlqUrl, eventsQueueUrl, eventsDlqUrl }, null, 2));
}

try {
  void main().catch((error: unknown) => {
    console.error('Failed to set up SQS queues:', error);
    process.exitCode = 1;
  });
} finally {
  client.destroy();
}
