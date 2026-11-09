import { describe, expect, it } from 'bun:test';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';
import { IntegrationEvent, type IntegrationEventProps } from './integration-event';

const t0 = new Date('2026-01-01T00:00:00.000Z');
class ExampleEvent extends IntegrationEvent<{ amount: string; nested: { value: string } }> {
  readonly eventType = 'ExampleEvent';
  readonly version = 1;
  static create(props: IntegrationEventProps<{ amount: string; nested: { value: string } }>): ExampleEvent {
    return new ExampleEvent(props);
  }
}
const example = () => ExampleEvent.create({
  eventId: 'event-1', aggregateId: 'wallet-1', correlationId: 'corr-1',
  occurredAt: t0, data: { amount: '25.00', nested: { value: 'initial' } },
});

// Domain tests only. Uniqueness and the SQL transaction boundary are persistence responsibilities.
describe('InboxMessage', () => {
  it('receives a message with unprocessed status', () => {
    const inbox = InboxMessage.receive({ messageId: 'sqs-1', consumerName: 'wager-consumer', payloadHash: 'a'.repeat(64), receivedAt: t0 });
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
  });
  it('marks processed once and rejects repeated completion', () => {
    const inbox = InboxMessage.receive({ messageId: 'sqs-1', consumerName: 'wager-consumer', payloadHash: 'a'.repeat(64), receivedAt: t0 });
    inbox.markProcessed(new Date('2026-01-01T00:01:00Z'));
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(new Date())).toThrow();
  });
  it('rejects invalid identifiers and payload hash', () => {
    expect(() => InboxMessage.receive({ messageId: '', consumerName: 'consumer', payloadHash: 'a'.repeat(64) })).toThrow();
    expect(() => InboxMessage.receive({ messageId: 'id', consumerName: 'consumer', payloadHash: 'bad' })).toThrow();
  });
  it('rehydrates processed state and returns defensive dates', () => {
    const inbox = InboxMessage.rehydrate({ messageId: 'sqs-1', consumerName: 'consumer', payloadHash: 'a'.repeat(64), receivedAt: t0, processedAt: t0 });
    expect(inbox.isProcessed()).toBe(true);
    inbox.receivedAt.setFullYear(2000);
    expect(inbox.receivedAt.getUTCFullYear()).toBe(2026);
  });
});

describe('IntegrationEvent and OutboxMessage', () => {
  it('serializes stable event envelope with eventType and version', () => {
    const envelope = example().toJSON();
    expect(envelope.eventType).toBe('ExampleEvent');
    expect(envelope.version).toBe(1);
    expect(envelope.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });
  it('enqueues and is due at occurrence time', () => {
    const outbox = OutboxMessage.enqueue(example());
    expect(outbox.id).toBe('event-1');
    expect(outbox.attempts).toBe(0);
    expect(outbox.isDue(t0)).toBe(true);
  });
  it('backs off exponentially and caps retries', () => {
    const outbox = OutboxMessage.enqueue(example());
    outbox.scheduleRetry(t0);
    expect(outbox.nextAttemptAt?.getTime()).toBe(t0.getTime() + 1000);
    expect(outbox.isDue(t0)).toBe(false);
    outbox.scheduleRetry(t0);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(t0.getTime() + 2000);
    for (let i = 0; i < 20; i++) outbox.scheduleRetry(t0);
    expect(outbox.nextAttemptAt?.getTime()).toBe(t0.getTime() + 3_600_000);
  });
  it('marks published and cannot retry or republish', () => {
    const outbox = OutboxMessage.enqueue(example());
    outbox.markPublished(t0);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date('2030-01-01'))).toBe(false);
    expect(() => outbox.scheduleRetry(t0)).toThrow();
    expect(() => outbox.markPublished(t0)).toThrow();
  });
  it('rehydrates a due retry without resetting attempts', () => {
    const outbox = OutboxMessage.rehydrate({ id: 'event-1', aggregateId: 'wallet-1', eventType: 'ExampleEvent', payload: { eventId: 'event-1' }, occurredAt: t0, attempts: 3, nextAttemptAt: new Date(t0.getTime() + 5000) });
    expect(outbox.attempts).toBe(3);
    expect(outbox.isDue(new Date(t0.getTime() + 5000))).toBe(true);
  });
  it('prevents caller mutation of event and outbox payloads', () => {
    const event = example();
    const data = event.data;
    data.nested.value = 'mutated';
    expect(event.data.nested.value).toBe('initial');
    const outbox = OutboxMessage.enqueue(event);
    const payload = outbox.payload as { data: { nested: { value: string } } };
    payload.data.nested.value = 'mutated';
    const fresh = outbox.payload as unknown as { data: { nested: { value: string } } };
    expect(fresh.data.nested.value).toBe('initial');
  });
});
