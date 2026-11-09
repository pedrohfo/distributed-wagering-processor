import { Money, type MoneyProps } from '../common/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Stable public codes; expand the taxonomy in ARCHITECTURE.md as use cases are built. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export class InvalidTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus, operation: string) {
    super(`Cannot ${operation} transaction in status ${status}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly createdAtEpochMs: number,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAtEpochMs?: number,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    
    for (const value of [
      props.id, props.providerId, props.externalTransactionId,
      props.idempotencyKey, props.walletId, props.playerId,
      props.roundId, props.gameId,
    ]) {
      if (!value?.trim()) throw new InvalidTransactionError('Required transaction identifier is missing');
    }
    if (!/^[a-f\d]{64}$/i.test(props.payloadHash)) {
      throw new InvalidTransactionError('payloadHash must be a SHA-256 hexadecimal digest');
    }
    const allowedKinds: readonly string[] = [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ];

    if (!allowedKinds.includes(props.kind)) {
      throw new InvalidTransactionError(
        'Invalid external transaction kind',
      );
    }
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('Transaction amount must be positive');
    }
    const reference = props.referenceExternalTransactionId;
    const needsReference = props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (needsReference && !reference?.trim()) {
      throw new InvalidTransactionError('REFUND and ROLLBACK require an external reference');
    }
    if (reference !== undefined && !reference.trim()) {
      throw new InvalidTransactionError('Reference cannot be blank');
    }
    if (!needsReference && props.kind !== WagerTransactionKind.Win && reference !== undefined) {
      throw new InvalidTransactionError('Only WIN, REFUND and ROLLBACK accept references');
    }
    const createdAt = props.createdAt ?? new Date();
    if (!Number.isFinite(createdAt.getTime())) throw new InvalidTransactionError('Invalid creation date');
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId,
      props.idempotencyKey, props.payloadHash, props.walletId, props.playerId,
      props.roundId, props.gameId, props.kind, props.money, reference,
      createdAt.getTime(), WagerTransactionStatus.Pending,
    );
  }

  /** Only wallet-creation application service can call this internal factory. */
  static createOpening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.id?.trim() || !props.walletId?.trim() || !props.playerId?.trim() || !props.money.isPositive()) {
      throw new InvalidTransactionError('Invalid OPENING transaction');
    }
    const at = props.createdAt ?? new Date();
    if (!Number.isFinite(at.getTime())) throw new InvalidTransactionError('Invalid creation date');
    const internalId = `opening:${props.id}`;
    return new WagerTransaction(
      props.id, '__internal__', internalId, internalId, '0'.repeat(64),
      props.walletId, props.playerId, '__opening__', '__opening__',
      WagerTransactionKind.Opening, props.money, undefined,
      at.getTime(), WagerTransactionStatus.Pending,
    );
  }

  /** Reconstruct persisted state without replaying transition rules. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId,
      state.idempotencyKey, state.payloadHash, state.walletId,
      state.playerId, state.roundId, state.gameId,
      state.kind, Money.from(state.money), state.referenceExternalTransactionId,
      state.createdAt.getTime(), state.status, state.referenceTransactionId,
      state.failureCode, state.processedAt?.getTime(),
    );
  }

  get createdAt(): Date { return new Date(this.createdAtEpochMs); }
  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined {
    return this._processedAtEpochMs === undefined ? undefined : new Date(this._processedAtEpochMs);
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  markPendingReference(): void {
    this.assertMutable('mark pending-reference');
    if (!this.requiresReference()) {
      throw new InvalidTransactionError('Only REFUND and ROLLBACK may wait for references');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable('mark processed');
    if (this.requiresReference() && !referenceTransactionId?.trim()) {
      throw new InvalidTransactionError('Resolved reference ID required');
    }
    if (this.kind === WagerTransactionKind.Win && this.referenceExternalTransactionId && !referenceTransactionId?.trim()) {
      throw new InvalidTransactionError('WIN with an external reference must resolve it');
    }
    if (!this.requiresReference() && this.kind !== WagerTransactionKind.Win && referenceTransactionId !== undefined) {
      throw new InvalidTransactionError('Unexpected internal reference');
    }
    if (!Number.isFinite(at.getTime())) throw new InvalidTransactionError('Invalid processed date');
    this._referenceTransactionId = referenceTransactionId;
    this._processedAtEpochMs = at.getTime();
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: FailureCode): void {
    this.assertMutable('reject');
    this.assertFailureCode(code);
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertMutable('fail');
    this.assertFailureCode(code);
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  /** Validate reference semantics; uniqueness of reversals is enforced transactionally in PostgreSQL. */
  assertValidReference(reference: WagerTransaction): void {
    if (!this.referenceExternalTransactionId ||
        reference.externalTransactionId !== this.referenceExternalTransactionId ||
        reference.id === this.id ||
        reference.providerId !== this.providerId ||
        reference.playerId !== this.playerId ||
        reference.walletId !== this.walletId ||
        reference.roundId !== this.roundId ||
        !reference.money.equals(this.money) ||
        reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidTransactionError('Reference does not match transaction constraints');
    }
    if (this.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      throw new InvalidTransactionError('REFUND can only reverse a processed BET');
    }
    if (this.kind === WagerTransactionKind.Rollback && ![
      WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund,
    ].includes(reference.kind)) {
      throw new InvalidTransactionError('ROLLBACK reference kind is not supported');
    }
    if (this.kind !== WagerTransactionKind.Refund && this.kind !== WagerTransactionKind.Rollback && this.kind !== WagerTransactionKind.Win) {
      throw new InvalidTransactionError('Transaction kind does not allow a reference');
    }
    if (this.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
      throw new InvalidTransactionError('WIN may only reference a processed BET');
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund: return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS does not produce ledger entries');
      case WagerTransactionKind.Rollback:
        if (!reference) throw new InvalidTransactionError('ROLLBACK requires its reference');
        this.assertValidReference(reference);
        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
  }

  private assertMutable(operation: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, operation);
  }

  private assertFailureCode(code: FailureCode): void {
    if (!Object.values(FailureCode).includes(code)) {
      throw new InvalidTransactionError('Invalid failure code');
    }
  }
}
