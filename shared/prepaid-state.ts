/**
 * How a prepaid/PAYG state reads to a customer, an agent and an auditor.
 *
 * A prepaid screen is mostly about what the platform will *not* claim: that
 * energy remains when nothing measures consumption, that a token exists when
 * this deployment holds no vending key, that money arrived when the provider has
 * said nothing. Those refusals are named once here so the web app and the mobile
 * app cannot word them differently — a customer told "0 kWh left" on the phone
 * and "unknown" on the web has been told nothing.
 */

export type Tone = 'live' | 'good' | 'warning' | 'danger' | 'neutral';

export interface StateCopy {
  label: string;
  tone: Tone;
  meaning: string;
}

/** Why a remaining-energy figure is withheld. */
export const BALANCE_UNAVAILABLE_COPY: Record<string, StateCopy> = {
  unavailable_no_meter_integration: {
    label: 'remaining unknown',
    tone: 'warning',
    meaning:
      'No meter is linked to this account, so nothing measures the energy taken. The energy bought is known; what is left is not, and showing the purchase as the balance would tell you that you have energy you may already have used.',
  },
};

/** What a balance figure rests on. */
export const BALANCE_BASIS_COPY: Record<string, StateCopy> = {
  metered: {
    label: 'metered',
    tone: 'good',
    meaning: "Energy bought, minus the energy this account's meter register reported as taken.",
  },
  credited_only: {
    label: 'credit only',
    tone: 'warning',
    meaning: 'Energy bought. Consumption is unmeasured on this account, so no remaining figure follows from it.',
  },
};

/** Why a payment produced no token. Each of these is an answer, not a failure. */
export const WITHHELD_REASON_COPY: Record<string, StateCopy> = {
  payment_not_confirmed: {
    label: 'payment not confirmed',
    tone: 'neutral',
    meaning:
      'The provider has not confirmed the money yet. Nothing is credited until it does; the purchase stays open and the token is issued automatically when confirmation arrives.',
  },
  payment_evidence_missing: {
    label: 'no provider reference',
    tone: 'warning',
    meaning:
      'The payment is marked complete but carries no provider reference, so there is no evidence money arrived. An agent must reconcile it against the provider before any energy is credited.',
  },
  ledger_refused: {
    label: 'ledger refused',
    tone: 'danger',
    meaning:
      'The double-entry ledger refused the purchase, so no balance can be asserted for it and no token is vended. The payment is on record and owed.',
  },
  unavailable_ledger_not_posted: {
    label: 'ledger unavailable',
    tone: 'warning',
    meaning:
      'The purchase is not on the ledger yet, so the energy is owed but not credited. Issuance retries; nothing is vended on an unposted movement.',
  },
  unavailable_no_token_key: {
    label: 'no vending key',
    tone: 'danger',
    meaning:
      "This deployment holds no vending key for this meter, so it cannot produce digits the meter would accept. The energy is paid for and owed — a code invented here would simply be rejected at the keypad.",
  },
  unavailable_keyring_unreadable: {
    label: 'keyring unreadable',
    tone: 'danger',
    meaning:
      'The vending keyring is configured but cannot be read, so no token can be produced. This is a deployment fault, not a customer one; the energy is owed.',
  },
  unavailable_scheme_not_implemented: {
    label: 'scheme unsupported',
    tone: 'danger',
    meaning:
      'This meter vends on a scheme this deployment has no certified integration for (STS vending needs a certified HSM). No token can be produced here.',
  },
  unavailable_no_meter_integration: {
    label: 'no meter linked',
    tone: 'warning',
    meaning: 'No meter is linked to this account, so consumption cannot be read from it.',
  },
  prepaid_account_not_resolved: {
    label: 'account unknown',
    tone: 'warning',
    meaning:
      'The payment does not say which prepaid meter it is for, and its payer has more than one account (or none). An agent must attach it to the right meter.',
  },
  value_exceeds_token_range: {
    label: 'purchase too large for one token',
    tone: 'warning',
    meaning:
      'One standard OpenPAYGO token cannot carry this much energy for this device. The purchase must be vended as several tokens rather than as digits no verified implementation accepts.',
  },
};

/** What a device said, or failed to say, about a code. */
export const TOKEN_CHECK_COPY: Record<string, StateCopy> = {
  accepted: {
    label: 'would be accepted',
    tone: 'good',
    meaning:
      "The standard's decoder accepts this code for this device at its current count. This is not a report from the physical meter.",
  },
  already_used: {
    label: 'already used',
    tone: 'warning',
    meaning:
      'This code has already been recorded as accepted by the meter. A token credits a meter once; a further purchase is needed for more energy.',
  },
  invalid: {
    label: 'not valid here',
    tone: 'danger',
    meaning:
      'This code does not decode for this device. It may belong to another meter, or have been mistyped — the same digits can be a valid token on a different device.',
  },
  undecidable: {
    label: 'cannot be checked',
    tone: 'warning',
    meaning:
      'The reference decoder could not answer for this code, so the platform will not say whether the meter would take it. Neither an acceptance nor a rejection can be reported from a check that did not complete.',
  },
};

/** The lifecycle of a vended token. */
export const TOKEN_STATUS_COPY: Record<string, StateCopy> = {
  issued: {
    label: 'issued',
    tone: 'live',
    meaning: 'Vended and not yet reported as accepted by the meter. Enter it on the keypad to load the credit.',
  },
  redeemed: {
    label: 'loaded',
    tone: 'good',
    meaning: 'Recorded as accepted by the meter, with the evidence that says so. It cannot be used again.',
  },
  void: {
    label: 'void',
    tone: 'danger',
    meaning: 'Voided before use, with the reason on the record. It will not credit the meter.',
  },
};

export const SUPPLY_ACTION_COPY: Record<string, StateCopy> = {
  disconnect: { label: 'disconnected', tone: 'danger', meaning: 'Supply was decided against for this account.' },
  reconnect: { label: 'reconnected', tone: 'good', meaning: 'Supply was decided in favour of this account.' },
};

export const SUPPLY_REASON_LABEL: Record<string, string> = {
  credit_exhausted: 'credit exhausted',
  operator_request: 'operator request',
  customer_request: 'customer request',
  fault: 'fault',
  credit_restored: 'credit restored',
};

export const CONSUMPTION_SOURCE_COPY: Record<string, StateCopy> = {
  meter_register: {
    label: 'meter register',
    tone: 'good',
    meaning: "Measured as the movement of the meter's cumulative register between two readings.",
  },
  meter_reset_gap: {
    label: 'register reset',
    tone: 'warning',
    meaning:
      'The register fell — a reset, a replacement or a re-serialised device. The energy taken across that discontinuity is unknown, and is charged as zero rather than guessed.',
  },
};

export const ACCOUNT_STATUS_COPY: Record<string, StateCopy> = {
  active: { label: 'active', tone: 'good', meaning: 'Vending and consumption are both in normal operation.' },
  suspended: { label: 'suspended', tone: 'warning', meaning: 'No new tokens are vended for this account.' },
  disconnected: {
    label: 'disconnected',
    tone: 'danger',
    meaning: 'Supply has been decided against. Whether a meter enforced it is recorded separately.',
  },
  closed: { label: 'closed', tone: 'neutral', meaning: 'The account is closed; its history is retained.' },
};

/** Watt-hours as a customer reads them, with unknown staying unknown. */
export function kwhLabel(wh: number | null | undefined): string | null {
  if (wh === null || wh === undefined) return null;
  return (wh / 1000).toFixed(wh % 1000 === 0 ? 0 : 2);
}

export function copyFor(map: Record<string, StateCopy>, key: string | null | undefined): StateCopy {
  if (key && map[key]) return map[key];
  return {
    label: key ?? 'unknown',
    tone: 'neutral',
    meaning: 'No description is recorded for this state, so nothing is asserted about it.',
  };
}

/** The vending posture of the whole deployment, stated plainly. */
export function vendingCopy(configured: boolean): StateCopy {
  return configured
    ? {
        label: 'vending configured',
        tone: 'good',
        meaning: 'A keyring is loaded, so a confirmed payment can be turned into a token a meter will accept.',
      }
    : {
        label: 'vending unavailable',
        tone: 'danger',
        meaning:
          'No OpenPAYGO keyring is configured. Payments are recorded and the energy is owed, but no token can be produced on this deployment.',
      };
}
