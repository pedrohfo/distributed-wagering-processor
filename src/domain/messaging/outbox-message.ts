import { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Backoff policy: 1s, 2s, 4s ... capped at 1 hour. */
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 3_600_000;

function copyPayload(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function assertDate(date: Date): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Invalid date');
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    private readonly _payload: Readonly<Record<string, unknown>>,
    private readonly occurredAtMs: number,
    private _attempts: number,
    private _nextAttemptAtMs?: number,
    private _publishedAtMs?: number,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    if (!event.eventType || !Number.isInteger(event.version) || event.version < 1) {
      throw new Error('Invalid integration event type/version');
    }
    return new OutboxMessage(
      event.eventId, event.aggregateId, event.eventType,
      copyPayload(envelope as unknown as Record<string, unknown>),
      event.occurredAt.getTime(), 0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType,
      copyPayload(state.payload), state.occurredAt.getTime(),
      state.attempts, state.nextAttemptAt?.getTime(), state.publishedAt?.getTime(),
    );
  }

  get payload(): Readonly<Record<string, unknown>> { return copyPayload(this._payload); }
  get occurredAt(): Date { return new Date(this.occurredAtMs); }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAtMs === undefined ? undefined : new Date(this._nextAttemptAtMs);
  }
  get publishedAt(): Date | undefined {
    return this._publishedAtMs === undefined ? undefined : new Date(this._publishedAtMs);
  }

  isPending(): boolean { return this._publishedAtMs === undefined; }
  isDue(now: Date): boolean {
    assertDate(now);
    return this.isPending() && (this._nextAttemptAtMs ?? this.occurredAtMs) <= now.getTime();
  }

  markPublished(at: Date): void {
    assertDate(at);
    if (!this.isPending()) throw new Error('Outbox message already published');
    this._publishedAtMs = at.getTime();
    this._nextAttemptAtMs = undefined;
  }

  scheduleRetry(now: Date): void {
    assertDate(now);
    if (!this.isPending()) throw new Error('Cannot retry a published outbox message');
    this._attempts += 1;
    const multiplier = 2 ** Math.min(this._attempts - 1, 12);
    const delay = Math.min(RETRY_BASE_MS * multiplier, RETRY_CAP_MS);
    this._nextAttemptAtMs = now.getTime() + delay;
  }
}
