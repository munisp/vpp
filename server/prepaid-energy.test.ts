/**
 * Prepaid/PAYG accounting and vending invariants.
 *
 * These are the arithmetic and the token boundary only: nothing here touches the
 * database, so what a payment buys, what a meter register means and what the
 * OpenPAYGO encoder produces are pinned independently of any deployment.
 */
import { describe, expect, it } from 'vitest';
import {
  consumptionFromRegister,
  energyWhForPayment,
  prepaidBalance,
  tokenValueUnitsFor,
  MAX_TOKEN_VALUE_UNITS,
  PrepaidAccountingError,
} from './services/prepaid-accounting';
import { decodeTokenAsDevice, vendAddValueToken } from './services/prepaid-openpaygo';

const KEY_ENV = 'PREPAID_OPENPAYGO_KEYS';
const TEST_KEY = '0123456789abcdef0123456789abcdef';

describe('what a payment buys', () => {
  it('converts whole minor units at a tariff into whole watt-hours', () => {
    expect(energyWhForPayment({ amountMinor: 10_000, tariffMinorPerKwh: 5_000 })).toEqual({
      energyWh: 2_000,
      unspentMinor: 0,
    });
  });

  it('keeps the remainder visible instead of over-crediting', () => {
    const bought = energyWhForPayment({ amountMinor: 1_001, tariffMinorPerKwh: 5_000 });
    expect(bought.energyWh).toBe(200);
    expect(bought.unspentMinor).toBe(1);
  });

  it('refuses an amount that buys less than one watt-hour', () => {
    expect(() => energyWhForPayment({ amountMinor: 1, tariffMinorPerKwh: 5_000 })).toThrow(
      PrepaidAccountingError
    );
  });

  it('refuses fractional money and fractional tariffs', () => {
    expect(() => energyWhForPayment({ amountMinor: 100.5, tariffMinorPerKwh: 5_000 })).toThrow(
      PrepaidAccountingError
    );
    expect(() => energyWhForPayment({ amountMinor: 100, tariffMinorPerKwh: 0 })).toThrow(
      PrepaidAccountingError
    );
  });
});

describe('what a token can carry', () => {
  it('expresses energy in the units the device reads', () => {
    expect(tokenValueUnitsFor({ energyWh: 2_000, whPerValueUnit: 100 })).toBe(20);
  });

  it('refuses energy that is not a whole number of device units', () => {
    expect(() => tokenValueUnitsFor({ energyWh: 2_050, whPerValueUnit: 100 })).toThrow(
      /whole multiple/
    );
  });

  it('refuses more than one standard token can carry rather than vending unverifiable digits', () => {
    const beyond = (MAX_TOKEN_VALUE_UNITS + 1) * 100;
    expect(() => tokenValueUnitsFor({ energyWh: beyond, whPerValueUnit: 100 })).toThrow(
      /beyond the 995 one token can carry/
    );
    expect(tokenValueUnitsFor({ energyWh: MAX_TOKEN_VALUE_UNITS * 100, whPerValueUnit: 100 })).toBe(
      MAX_TOKEN_VALUE_UNITS
    );
  });
});

describe('what the meter register means', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

  it('measures consumption from register movement', () => {
    const segments = consumptionFromRegister({
      cursor: { at: at(0), registerWh: 10_000 },
      readings: [
        { at: at(30), registerWh: 10_500 },
        { at: at(60), registerWh: 11_200 },
      ],
    });
    expect(segments.map((s) => s.energyWh)).toEqual([500, 700]);
    expect(segments.every((s) => s.source === 'meter_register')).toBe(true);
  });

  it('records a register that did not move as zero, because the meter said so', () => {
    const segments = consumptionFromRegister({
      cursor: { at: at(0), registerWh: 10_000 },
      readings: [{ at: at(30), registerWh: 10_000 }],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].energyWh).toBe(0);
  });

  it('produces no segment at all when there is no reading, so the period stays unaccounted', () => {
    expect(consumptionFromRegister({ cursor: { at: at(0), registerWh: 10_000 }, readings: [] })).toEqual(
      []
    );
    // Nor can a first reading alone be a segment: it only seeds the cursor.
    expect(consumptionFromRegister({ cursor: null, readings: [{ at: at(0), registerWh: 10_000 }] })).toEqual(
      []
    );
  });

  it('treats a register that fell as a gap carrying zero energy, never a negative or a full re-read', () => {
    const segments = consumptionFromRegister({
      cursor: { at: at(0), registerWh: 11_200 },
      readings: [{ at: at(30), registerWh: 300 }],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].source).toBe('meter_reset_gap');
    expect(segments[0].energyWh).toBe(0);
    expect(segments[0].detail).toMatch(/fell from 11200 Wh to 300 Wh/);
  });

  it('ignores a corrupt register row instead of inventing energy from it', () => {
    const segments = consumptionFromRegister({
      cursor: { at: at(0), registerWh: 10_000 },
      readings: [
        { at: at(30), registerWh: -5 },
        { at: at(60), registerWh: 10_400 },
      ],
    });
    expect(segments.map((s) => s.energyWh)).toEqual([400]);
  });
});

describe('the balance a customer is shown', () => {
  it('is credit minus measured consumption when a meter measures it', () => {
    expect(prepaidBalance({ creditedWh: 2_000, consumedWh: 1_200, meterIntegrated: true })).toMatchObject(
      { remainingWh: 800, basis: 'metered', unavailableReason: null }
    );
  });

  it('withholds a remaining figure when no meter measures consumption', () => {
    const balance = prepaidBalance({ creditedWh: 2_000, consumedWh: 0, meterIntegrated: false });
    expect(balance.remainingWh).toBeNull();
    expect(balance.basis).toBe('credited_only');
    expect(balance.unavailableReason).toBe('unavailable_no_meter_integration');
  });
});

describe('the OpenPAYGO vending boundary', () => {
  function withKey<T>(body: () => T): T {
    const previous = process.env[KEY_ENV];
    process.env[KEY_ENV] = JSON.stringify({ 'device-a': TEST_KEY });
    try {
      return body();
    } finally {
      if (previous === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = previous;
    }
  }

  it('vends digits the standard decoder accepts, carrying exactly the value paid for', () => {
    withKey(() => {
      const vend = vendAddValueToken({
        keyRef: 'device-a',
        startingCode: 123456789,
        lastCount: 1,
        energyWh: 2_000,
        whPerValueUnit: 100,
      });
      expect(vend.tokenCode).toMatch(/^\d{9}$/);
      expect(vend.valueUnits).toBe(20);

      const accepted = decodeTokenAsDevice({
        keyRef: 'device-a',
        startingCode: 123456789,
        token: vend.tokenCode,
        lastCount: 1,
        usedCounts: [],
      });
      expect(accepted.reason).toBe('accepted');
      expect(accepted.valueUnits).toBe(20);
      // The reference decoder reports no count for a token it accepts, so the
      // count the platform stores is the encoder's, never inferred from a decode.
      expect(vend.tokenCount).toBeGreaterThan(1);
    });
  });

  it('does not accept digits this device never had vended to it', () => {
    withKey(() => {
      const other = decodeTokenAsDevice({
        keyRef: 'device-a',
        startingCode: 123456789,
        token: '000000000',
        lastCount: 1,
        usedCounts: [],
      });
      expect(other.accepted).toBe(false);
    });
  });

  it('refuses to vend for a device this deployment holds no key for', () => {
    withKey(() => {
      expect(() =>
        vendAddValueToken({
          keyRef: 'device-unknown',
          startingCode: 123456789,
          lastCount: 1,
          energyWh: 2_000,
          whPerValueUnit: 100,
        })
      ).toThrow(/unknown/);
    });
  });

  it('advances the count on every vend, so no two purchases share a token', () => {
    withKey(() => {
      const first = vendAddValueToken({
        keyRef: 'device-a',
        startingCode: 123456789,
        lastCount: 1,
        energyWh: 1_000,
        whPerValueUnit: 100,
      });
      const second = vendAddValueToken({
        keyRef: 'device-a',
        startingCode: 123456789,
        lastCount: first.tokenCount,
        energyWh: 1_000,
        whPerValueUnit: 100,
      });
      expect(second.tokenCount).toBeGreaterThan(first.tokenCount);
      expect(second.tokenCode).not.toBe(first.tokenCode);
    });
  });
});
