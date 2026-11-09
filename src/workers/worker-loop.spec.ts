import { describe, expect, it } from 'bun:test';
import { WorkerLoop, interruptibleSleep } from './worker-loop';
import { readWorkerSettings } from './worker-settings';

async function waitFor(predicate: () => boolean, maxMs = 1000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  if (!predicate()) throw new Error('Worker condition not reached before deadline');
}

describe('WorkerLoop', () => {
  it('polls without overlapping calls and stops cleanly', async () => {
    let count = 0;
    let active = 0;
    let maxActive = 0;
    const loop = new WorkerLoop('test', 1, async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      await Bun.sleep(8);
      count++;
      active--;
    }, () => { throw new Error('unexpected failure'); });
    loop.start();
    loop.start(); // double start must not start a second poller
    await waitFor(() => count >= 2);
    await loop.stop();
    const afterStop = count;
    await Bun.sleep(25);
    expect(maxActive).toBe(1);
    expect(count).toBe(afterStop);
    expect(loop.stats.running).toBe(false);
  });

  it('recovers after a failed cycle instead of exiting', async () => {
    let calls = 0;
    let reports = 0;
    const loop = new WorkerLoop('retry', 2, async () => {
      calls++;
      if (calls === 1) throw new Error('synthetic outage');
    }, () => { reports++; });
    loop.start();
    await waitFor(() => calls >= 3);
    await loop.stop();
    expect(reports).toBe(1);
    expect(loop.stats.errors).toBe(1);
    expect(loop.stats.ticks).toBeGreaterThanOrEqual(2);
  });

  it('waits for an in-flight cycle during shutdown', async () => {
    let started = false;
    let finished = false;
    const loop = new WorkerLoop('drain', 100, async () => {
      started = true;
      await Bun.sleep(25);
      finished = true;
    }, () => {});
    loop.start();
    await waitFor(() => started);
    await loop.stop();
    expect(finished).toBe(true);
  });

  it('interrupts sleep immediately on abort', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const task = interruptibleSleep(10_000, controller.signal);
    controller.abort();
    await task;
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('worker configuration', () => {
  const urls = {
    SQS_INBOX_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo',
    SQS_INBOX_DLQ_URL: 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo',
    SQS_OUTBOX_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/wager-events.fifo',
  };
  it('requires correct distinct queue URLs when enabled', () => {
    expect(() => readWorkerSettings({ WORKERS_ENABLED: '1' })).toThrow();
    expect(readWorkerSettings({ WORKERS_ENABLED: '1', ...urls }).enabled).toBe(true);
    expect(() => readWorkerSettings({ WORKERS_ENABLED: '1', ...urls,
      SQS_OUTBOX_QUEUE_URL: urls.SQS_INBOX_QUEUE_URL })).toThrow();
  });
  it('rejects integration-test databases to protect immutable fixtures', () => {
    expect(() => readWorkerSettings({ WORKERS_ENABLED: '1', ...urls,
      DB_NAME: 'backend_sqs_test' })).toThrow();
  });
  it('validates poll limits and accepts disabled mode', () => {
    expect(readWorkerSettings({}).enabled).toBe(false);
    expect(() => readWorkerSettings({ WORKER_INBOX_BATCH: '11' })).toThrow();
    expect(() => readWorkerSettings({ WORKER_REFERENCE_INTERVAL_MS: '0' })).toThrow();
  });
});
