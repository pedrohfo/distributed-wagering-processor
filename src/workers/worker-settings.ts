export interface WorkerSettings {
  enabled: boolean;
  inboxQueueUrl: string;
  inboxDlqUrl: string;
  outboxQueueUrl: string;
  inboxBatchSize: number;
  inboxWaitSeconds: number;
  inboxIntervalMs: number;
  outboxBatchSize: number;
  outboxIntervalMs: number;
  referenceBatchSize: number;
  referenceIntervalMs: number;
}

const integer = (
  env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number,
): number => {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export function readWorkerSettings(env: NodeJS.ProcessEnv): WorkerSettings {
  if (env.WORKERS_ENABLED !== undefined && !['0', '1'].includes(env.WORKERS_ENABLED)) {
    throw new Error('WORKERS_ENABLED must be 0 or 1');
  }
  const enabled = env.WORKERS_ENABLED === '1';
  const inboxQueueUrl = env.SQS_INBOX_QUEUE_URL ?? '';
  const inboxDlqUrl = env.SQS_INBOX_DLQ_URL ?? '';
  const outboxQueueUrl = env.SQS_OUTBOX_QUEUE_URL ?? '';
  if (enabled) {
    for (const [key, value] of [
      ['SQS_INBOX_QUEUE_URL', inboxQueueUrl],
      ['SQS_INBOX_DLQ_URL', inboxDlqUrl],
      ['SQS_OUTBOX_QUEUE_URL', outboxQueueUrl],
    ] as const) {
      if (!value.endsWith('.fifo')) throw new Error(`${key} must be a FIFO queue URL`);
    }
    if (new Set([inboxQueueUrl, inboxDlqUrl, outboxQueueUrl]).size !== 3) {
      throw new Error('Inbox, inbox DLQ, and outbox URLs must be distinct');
    }
    // A forgotten PowerShell integration-test override must not start live workers
    // that consume production queues while writing into a disposable test database.
    if (['backend_test', 'backend_sqs_test'].includes(env.DB_NAME ?? '')) {
      throw new Error('Refusing to start continuous workers on integration-test databases');
    }
  }
  return {
    enabled,
    inboxQueueUrl,
    inboxDlqUrl,
    outboxQueueUrl,
    inboxBatchSize: integer(env, 'WORKER_INBOX_BATCH', 10, 1, 10),
    inboxWaitSeconds: integer(env, 'WORKER_INBOX_WAIT_SECONDS', 2, 0, 20),
    inboxIntervalMs: integer(env, 'WORKER_INBOX_INTERVAL_MS', 250, 1, 60_000),
    outboxBatchSize: integer(env, 'WORKER_OUTBOX_BATCH', 10, 1, 100),
    outboxIntervalMs: integer(env, 'WORKER_OUTBOX_INTERVAL_MS', 500, 1, 60_000),
    referenceBatchSize: integer(env, 'WORKER_REFERENCE_BATCH', 20, 1, 500),
    referenceIntervalMs: integer(env, 'WORKER_REFERENCE_INTERVAL_MS', 1000, 1, 60_000),
  };
}
