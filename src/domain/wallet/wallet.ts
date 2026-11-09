import { Money, type MoneyProps } from '../common/money';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

export class InsufficientFundsError extends Error {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor() {
    super('Insufficient wallet balance');
    this.name = 'InsufficientFundsError';
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/** Aggregate root; database transaction boundary is owned by the use case. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly createdAtEpochMs: number,
    private updatedAtEpochMs: number,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new Error('Wallet requires an id and playerId');
    }
    if (props.initialBalance.isNegative()) {
      throw new Error('Initial balance cannot be negative');
    }
    const at = props.at ?? new Date();
    return new Wallet(
      props.id, props.playerId, props.initialBalance.currency,
      props.initialBalance, 1, at.getTime(), at.getTime(),
    );
  }

  /** Reconstruction does not re-execute transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id, state.playerId, state.currency,
      Money.from(state.balance), state.version,
      state.createdAt.getTime(), state.updatedAt.getTime(),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtEpochMs);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtEpochMs);
  }

  /** Called by wallet-creation use case when initialBalance > 0. */
  openingEntry(props: {
    ledgerEntryId: string;
    transactionId: string;
  }): WalletLedgerEntry | null {
    if (this._balance.isZero()) {
      return null;
    }
    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertPositiveAmount(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError();
    }
    const after = this._balance.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: props.at,
    });
    this.applyBalance(after, props.at);
    return entry;
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertPositiveAmount(props.money);
    const after = this._balance.add(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: props.at,
    });
    this.applyBalance(after, props.at);
    return entry;
  }

  private assertPositiveAmount(money: Money): void {
    if (!money.isPositive()) {
      throw new Error('Wallet movements must use a strictly positive amount');
    }
    // This comparison throws CurrencyMismatchError on currency mismatch.
    this._balance.isLessThan(money);
  }

  private applyBalance(next: Money, at: Date): void {
    this._balance = next;
    this._version += 1;
    this.updatedAtEpochMs = at.getTime();
  }
}
