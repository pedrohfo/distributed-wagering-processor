/** Domain event envelope; concrete events own their type and version. */
export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

function cloneJson<T>(value: T): T {
  // Integration event data is a JSON DTO, never a domain Money instance.
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new Error('Integration event data must be a JSON object');
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  private readonly occurredAtMs: number;
  private readonly _data: T;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const field of [props.eventId, props.aggregateId, props.correlationId]) {
      if (typeof field !== 'string' || !field.trim()) throw new Error('Integration event IDs are required');
    }
    if (!(props.occurredAt instanceof Date) || !Number.isFinite(props.occurredAt.getTime())) {
      throw new Error('Invalid event occurrence time');
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtMs = props.occurredAt.getTime();
    this._data = cloneJson(props.data);
  }

  get occurredAt(): Date { return new Date(this.occurredAtMs); }
  get data(): Readonly<T> { return cloneJson(this._data); }

  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: cloneJson(this._data),
    };
    if (this.causationId !== undefined) envelope.causationId = this.causationId;
    return envelope;
  }
}
