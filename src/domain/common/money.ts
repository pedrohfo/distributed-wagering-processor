import Decimal from 'decimal.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} and ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * Immutable amount with two decimal places.
 * Public inputs never accept signed/negative amounts; internal arithmetic may
 * produce negative Money values for differences and comparisons.
 * NUMERIC(18,2) bounds are also enforced here.
 */
export class Money {
  private static readonly MAX_ABSOLUTE_AMOUNT = new Decimal('9999999999999999.99');
  private static readonly DECIMAL_INPUT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
  private static readonly CURRENCY_CODE = /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (
      !value.isFinite() ||
      value.decimalPlaces() > 2 ||
      value.abs().greaterThan(Money.MAX_ABSOLUTE_AMOUNT)
    ) {
      throw new InvalidMoneyError('Amount must fit NUMERIC(18,2) without rounding');
    }
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== 'string' ||
      !Money.DECIMAL_INPUT.test(props.amount)
    ) {
      throw new InvalidMoneyError('Amount must be a non-negative decimal string with up to 2 fractional digits');
    }
    Money.assertCurrencyCode(props.currency);
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrencyCode(currency: string): void {
    if (typeof currency !== 'string' || !Money.CURRENCY_CODE.test(currency)) {
      throw new InvalidMoneyError('Currency must be an uppercase 3-letter ISO-4217 code');
    }
  }
}
