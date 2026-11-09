import { Money, type MoneyProps } from '../common/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

/** Append-only domain object. There are no setters or transition methods. */
export class WalletLedgerEntry {
  private readonly createdAtEpochMs: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtEpochMs = createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new Error('Ledger requires id, walletId and transactionId');
    }
    if (!props.money.isPositive()) {
      throw new Error('Ledger entry amount must be strictly positive');
    }
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new Error('Invalid ledger direction');
    }
    const expected = props.direction === LedgerDirection.Credit
      ? props.balanceBefore.add(props.money)
      : props.balanceBefore.subtract(props.money);
    if (expected.isNegative() || !expected.equals(props.balanceAfter)) {
      throw new Error('Ledger entry does not balance');
    }
    return new WalletLedgerEntry(
      props.id, props.walletId, props.transactionId, props.direction,
      props.money, props.balanceBefore, props.balanceAfter, props.createdAt,
    );
  }

  /** Rebuild persisted state without re-running transition rules. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction,
      Money.from(state.money), Money.from(state.balanceBefore),
      Money.from(state.balanceAfter), state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtEpochMs);
  }

  isBalanced(): boolean {
    const calculated = this.direction === LedgerDirection.Credit
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return !calculated.isNegative() && calculated.equals(this.balanceAfter);
  }
}
