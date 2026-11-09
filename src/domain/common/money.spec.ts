import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

describe('Money', () => {
  it('normalizes output to exactly two decimals', () => {
    expect(money('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money('0.1').toString()).toBe('0.10 BRL');
  });

  it('adds and subtracts without floating point errors', () => {
    expect(money('0.10').add(money('0.20')).toJSON().amount).toBe('0.30');
    expect(money('100.00').subtract(money('80.00')).toJSON().amount).toBe('20.00');
  });

  it('supports internal negative amounts without accepting them from input', () => {
    const difference = money('2.00').subtract(money('3.00'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().toJSON().amount).toBe('1.00');
    expect(() => money('-1.00')).toThrow(InvalidMoneyError);
  });

  for (const invalid of [
    '', ' ', 'NaN', 'Infinity', '1e3', '1.001',
    '-0.01', ' 1.00', '1,00', '01.00',
    '99999999999999999.00',
  ]) {
    it(`rejects invalid input: ${JSON.stringify(invalid)}`, () => {
      expect(() => money(invalid)).toThrow(InvalidMoneyError);
    });
  }

  it('rejects incompatible currencies', () => {
    expect(() => money('1.00', 'BRL').add(money('1.00', 'USD')))
      .toThrow(CurrencyMismatchError);
  });

  it('rejects non-canonical currency codes', () => {
    expect(() => money('1.00', 'brl')).toThrow(InvalidMoneyError);
  });

  it('rejects overflow rather than rounding', () => {
    expect(() => money('9999999999999999.99').add(money('0.01')))
      .toThrow(InvalidMoneyError);
  });

  it('exposes comparisons and zero accurately', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(money('0.01').isPositive()).toBe(true);
    expect(money('1.00').isLessThan(money('2.00'))).toBe(true);
    expect(money('1.0').equals(money('1.00'))).toBe(true);
  });
});
