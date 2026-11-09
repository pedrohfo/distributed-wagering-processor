export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly receivedAtMs: number,
    private _processedAtMs?: number,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of [props.messageId, props.consumerName]) {
      if (typeof field !== 'string' || !field.trim()) throw new Error('Inbox message identifiers are required');
    }
    if (!/^[a-f\d]{64}$/i.test(props.payloadHash)) throw new Error('Invalid SHA-256 payload hash');
    const receivedAt = props.receivedAt ?? new Date();
    InboxMessage.assertDate(receivedAt);
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, receivedAt.getTime());
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt.getTime(),
      state.processedAt?.getTime(),
    );
  }

  get receivedAt(): Date { return new Date(this.receivedAtMs); }
  get processedAt(): Date | undefined {
    return this._processedAtMs === undefined ? undefined : new Date(this._processedAtMs);
  }
  isProcessed(): boolean { return this._processedAtMs !== undefined; }

  markProcessed(at: Date): void {
    InboxMessage.assertDate(at);
    if (this.isProcessed()) throw new Error('Inbox message has already been processed');
    if (at.getTime() < this.receivedAtMs) throw new Error('Processing time precedes receipt');
    this._processedAtMs = at.getTime();
  }

  private static assertDate(at: Date): void {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('Invalid date');
  }
}
