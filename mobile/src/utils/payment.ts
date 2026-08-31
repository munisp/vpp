/**
 * Pure helpers for payment form handling, extracted from PaymentsScreen so the
 * rules are testable without mounting React Native.
 *
 * Server contract (server/routers/payments.ts -> InitiatePaymentInputSchema):
 * amount is an integer in cents, energyKwh is a positive integer number of
 * kWh and is only meaningful for token purchases.
 */

export type PaymentType = 'invoice' | 'token_purchase';

export interface PaymentFormFields {
  phoneNumber: string;
  /** TZS amount exactly as typed by the user. */
  amount: string;
  paymentType: PaymentType;
  /** kWh exactly as typed by the user; only read for token purchases. */
  energyKwh: string;
}

export type PaymentValidation =
  | {
      ok: true;
      /** Whole TZS parsed from the input. */
      amountTzs: number;
      /** Amount in cents, as the server expects. */
      amountCents: number;
      /** Present only for token purchases. */
      energyKwhInt?: number;
    }
  | {
      ok: false;
      reason: 'missing_fields' | 'invalid_amount' | 'invalid_energy';
      message: string;
    };

export function validatePaymentForm(fields: PaymentFormFields): PaymentValidation {
  if (!fields.phoneNumber || !fields.amount) {
    return {
      ok: false,
      reason: 'missing_fields',
      message: 'Please enter phone number and amount',
    };
  }

  const amountTzs = parseInt(fields.amount, 10);
  if (isNaN(amountTzs) || amountTzs <= 0) {
    return {
      ok: false,
      reason: 'invalid_amount',
      message: 'Please enter a valid amount',
    };
  }

  let energyKwhInt: number | undefined;
  if (fields.paymentType === 'token_purchase') {
    const parsedKwh = parseInt(fields.energyKwh, 10);
    if (isNaN(parsedKwh) || parsedKwh <= 0) {
      return {
        ok: false,
        reason: 'invalid_energy',
        message: 'Please enter a valid energy amount (kWh)',
      };
    }
    energyKwhInt = parsedKwh;
  }

  return { ok: true, amountTzs, amountCents: amountTzs * 100, energyKwhInt };
}

/** Render a cents amount as whole TZS, or an em dash when there is no figure. */
export function formatCentsTzs(cents: number | null | undefined): string {
  return cents == null ? '—' : `${(cents / 100).toFixed(0)} TZS`;
}
