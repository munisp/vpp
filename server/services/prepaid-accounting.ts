/**
 * Prepaid energy arithmetic.
 *
 * Everything here is pure and integral. Money arrives in whole minor units, a
 * tariff is quoted in whole minor units per kWh, and a meter counts whole
 * watt-hours, so every conversion between them either divides exactly or is
 * refused. Nothing rounds silently: a purchase that cannot be expressed as whole
 * watt-hours at the account's tariff is a refusal the caller must handle, not a
 * few watt-hours quietly kept by whichever side the rounding favoured.
 */

/** Why a purchase, a token or a consumption reading cannot be accounted for. */
export type PrepaidRefusal =
  | 'amount_not_positive'
  | 'tariff_not_positive'
  | 'amount_below_minimum_unit'
  | 'energy_not_divisible_by_device_unit'
  | 'value_exceeds_token_range'
  | 'device_unit_not_positive';

export class PrepaidAccountingError extends Error {
  readonly refusal: PrepaidRefusal;

  constructor(refusal: PrepaidRefusal, message: string) {
    super(message);
    this.name = 'PrepaidAccountingError';
    this.refusal = refusal;
  }
}

const WH_PER_KWH = 1000;

/**
 * The largest value a standard OpenPAYGO token can carry (`MAX_ACTIVATION_VALUE`
 * in the standard, 995 device units).
 *
 * The standard also defines a 12-digit extended token carrying up to 999 999
 * units, and it is deliberately not used: in the reference library (`openpaygo`
 * 0.0.6) the extended encoder throws on values in the tens of thousands and its
 * own decoder rejects every extended token it produces, so a token vended that
 * way is one no verified implementation accepts. A purchase needing more than
 * 995 device units is therefore refused, with the device unit named, rather than
 * vended as digits that may not work.
 */
export const MAX_TOKEN_VALUE_UNITS = 995;

/**
 * Whole watt-hours a payment buys at a tariff.
 *
 * Truncation is towards the platform's customer never being over-credited, and
 * the remainder is returned rather than discarded so a caller can show the
 * customer what their money did not quite reach.
 */
export function energyWhForPayment(input: {
  amountMinor: number;
  tariffMinorPerKwh: number;
}): { energyWh: number; unspentMinor: number } {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PrepaidAccountingError(
      'amount_not_positive',
      `A prepaid purchase must be a whole positive amount of minor units, received ${input.amountMinor}`
    );
  }
  if (!Number.isInteger(input.tariffMinorPerKwh) || input.tariffMinorPerKwh <= 0) {
    throw new PrepaidAccountingError(
      'tariff_not_positive',
      `A prepaid account must have a whole positive tariff, received ${input.tariffMinorPerKwh}`
    );
  }

  // amountMinor / (tariffMinorPerKwh / 1000 Wh) in integer arithmetic.
  const energyWh = Math.floor((input.amountMinor * WH_PER_KWH) / input.tariffMinorPerKwh);
  if (energyWh <= 0) {
    throw new PrepaidAccountingError(
      'amount_below_minimum_unit',
      `${input.amountMinor} minor units at ${input.tariffMinorPerKwh} per kWh buys less than one whole watt-hour`
    );
  }
  const spentMinor = Math.ceil((energyWh * input.tariffMinorPerKwh) / WH_PER_KWH);
  return { energyWh, unspentMinor: Math.max(0, input.amountMinor - spentMinor) };
}

/**
 * The value digits a token must carry for an amount of energy, in the units the
 * device was configured to read them in.
 */
export function tokenValueUnitsFor(input: {
  energyWh: number;
  whPerValueUnit: number;
}): number {
  if (!Number.isInteger(input.whPerValueUnit) || input.whPerValueUnit <= 0) {
    throw new PrepaidAccountingError(
      'device_unit_not_positive',
      `A device unit must be a whole positive number of watt-hours, received ${input.whPerValueUnit}`
    );
  }
  if (!Number.isInteger(input.energyWh) || input.energyWh <= 0) {
    throw new PrepaidAccountingError(
      'amount_not_positive',
      `A token must credit a whole positive number of watt-hours, received ${input.energyWh}`
    );
  }
  if (input.energyWh % input.whPerValueUnit !== 0) {
    throw new PrepaidAccountingError(
      'energy_not_divisible_by_device_unit',
      `${input.energyWh} Wh is not a whole multiple of this device's ${input.whPerValueUnit} Wh unit, so a token would credit a different amount than was paid for`
    );
  }
  const value = input.energyWh / input.whPerValueUnit;
  if (value > MAX_TOKEN_VALUE_UNITS) {
    throw new PrepaidAccountingError(
      'value_exceeds_token_range',
      `${input.energyWh} Wh needs a token value of ${value} device units, beyond the ${MAX_TOKEN_VALUE_UNITS} one token can carry: at ${input.whPerValueUnit} Wh per unit this device can be vended at most ${MAX_TOKEN_VALUE_UNITS * input.whPerValueUnit} Wh in one purchase`
    );
  }
  return value;
}

/** A single cumulative meter reading. */
export interface RegisterReading {
  at: Date;
  registerWh: number;
}

export interface ConsumptionSegment {
  fromAt: Date;
  toAt: Date;
  registerStartWh: number;
  registerEndWh: number;
  energyWh: number;
  source: 'meter_register' | 'meter_reset_gap';
  detail: string | null;
}

/**
 * Consumption between successive readings of a cumulative register.
 *
 * Only the register is trusted. A period in which the register did not move is
 * zero energy *because the meter said so*, which is a different fact from a
 * period with no reading at all — the latter produces no segment, so it stays
 * unaccounted rather than becoming a free hour for the customer or an estimated
 * charge against them.
 *
 * A register that moves backwards is a reset, a replacement or a re-serialised
 * device. It yields a `meter_reset_gap` segment carrying zero energy and the
 * reason, so the discontinuity is on the record and the customer is charged
 * neither for a negative delta nor for the whole new register.
 */
export function consumptionFromRegister(input: {
  cursor: RegisterReading | null;
  readings: RegisterReading[];
}): ConsumptionSegment[] {
  const ordered = [...input.readings].sort((a, b) => a.at.getTime() - b.at.getTime());
  const segments: ConsumptionSegment[] = [];
  let previous = input.cursor;

  for (const reading of ordered) {
    if (!Number.isInteger(reading.registerWh) || reading.registerWh < 0) {
      // A negative or fractional cumulative register is not a reading of
      // anything; skipping it leaves the period unaccounted rather than
      // inventing energy from a corrupt row.
      continue;
    }
    if (!previous) {
      previous = reading;
      continue;
    }
    if (reading.at.getTime() <= previous.at.getTime()) {
      continue;
    }

    const delta = reading.registerWh - previous.registerWh;
    if (delta < 0) {
      segments.push({
        fromAt: previous.at,
        toAt: reading.at,
        registerStartWh: previous.registerWh,
        registerEndWh: reading.registerWh,
        energyWh: 0,
        source: 'meter_reset_gap',
        detail: `The meter's cumulative register fell from ${previous.registerWh} Wh to ${reading.registerWh} Wh, so the energy taken in this period is unknown`,
      });
    } else {
      segments.push({
        fromAt: previous.at,
        toAt: reading.at,
        registerStartWh: previous.registerWh,
        registerEndWh: reading.registerWh,
        energyWh: delta,
        source: 'meter_register',
        detail: null,
      });
    }
    previous = reading;
  }

  return segments;
}

/** How much a balance figure can be believed. */
export type PrepaidBalanceBasis =
  /** Credit vended minus energy the meter measured. */
  | 'metered'
  /** Credit vended; consumption is unknown because no meter measures it. */
  | 'credited_only';

export interface PrepaidBalance {
  creditedWh: number;
  consumedWh: number;
  /** Null when consumption is unmeasured: remaining credit is not knowable. */
  remainingWh: number | null;
  basis: PrepaidBalanceBasis;
  /** Machine-readable reason a remaining balance is withheld. */
  unavailableReason: 'unavailable_no_meter_integration' | null;
}

/**
 * The balance a customer can be shown.
 *
 * With no meter behind the account, `remainingWh` is null. Reporting the
 * credited figure as remaining would tell a customer they have energy they may
 * already have used, which is the exact failure this subsystem exists to avoid.
 */
export function prepaidBalance(input: {
  creditedWh: number;
  consumedWh: number;
  meterIntegrated: boolean;
}): PrepaidBalance {
  if (!input.meterIntegrated) {
    return {
      creditedWh: input.creditedWh,
      consumedWh: input.consumedWh,
      remainingWh: null,
      basis: 'credited_only',
      unavailableReason: 'unavailable_no_meter_integration',
    };
  }
  return {
    creditedWh: input.creditedWh,
    consumedWh: input.consumedWh,
    // Can go negative: a meter that ran past its credit is a real overdraft, and
    // clamping it to zero would hide energy that was supplied unpaid.
    remainingWh: input.creditedWh - input.consumedWh,
    basis: 'metered',
    unavailableReason: null,
  };
}
