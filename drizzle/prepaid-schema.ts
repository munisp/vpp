/**
 * Prepaid / pay-as-you-go energy tables.
 *
 * Most customers of a mini-grid in the markets this platform targets buy energy
 * before they use it, from a phone, in small amounts. The platform already took
 * their money: `payments.paymentType = 'token_purchase'` charged a customer and
 * then asked `generateSTSToken()` for a code, which refuses (correctly — there
 * is no certified STS vending system behind it), leaving a `tokens` row reading
 * `PENDING_ISSUANCE_<id>` and a customer with no energy. Nothing recorded how
 * much energy that customer was owed, how much of it they had used, or whether
 * the code they were eventually given had already been used once.
 *
 * These tables are that record, built on the OpenPAYGO Token standard rather
 * than STS, because OpenPAYGO is open, documented and already spoken by the PAYG
 * solar and metering hardware sold across Africa — a token vended here can be
 * accepted by a third-party device without a per-utility vending licence.
 *
 *  - `prepaid_accounts` is one metered supply point sold on prepayment. It holds
 *    the OpenPAYGO device identity (serial, starting code, the count last
 *    vended) and the *reference* to the device's secret key — never the key
 *    itself, which stays in the deployment's keyring outside the database.
 *  - `prepaid_tokens` is one vend: the code handed to one customer for one
 *    payment. Its identity is `(account, payment, sequence)` and its OpenPAYGO
 *    `token_count` is unique per account, so a replayed payment callback
 *    re-reads the token it already issued instead of vending a second one, and a
 *    second vend can never re-use a count the device would then reject.
 *  - `prepaid_consumption` is energy actually taken, measured as the difference
 *    between two readings of the meter's cumulative register. Elapsed time is
 *    never treated as consumption: a customer whose meter has not reported has
 *    used an unknown amount, not zero.
 *  - `prepaid_supply_events` records a supply decision and who made it. It
 *    records that the platform decided, not that a meter obeyed: whether the
 *    device enforced it is only known where a meter integration reports back.
 *
 * A token's link to its double-entry posting is the `ledger_posting_id` column
 * rather than a separate link table: the relation is one posting per vend, so a
 * join table would only add a row that can disagree with the token it describes.
 *
 * Balances are whole watt-hours and whole minor currency units. There is no
 * floating-point energy or money anywhere in this subsystem, because a rounding
 * error here is either energy a customer paid for and did not get, or energy
 * given away.
 */

import {
  bigint,
  boolean,
  index,
  integer as int,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  varchar,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ledgerCurrencyEnum } from './ledger-schema';

/**
 * The token standard an account's device speaks. Only `openpaygo` is implemented:
 * `sts_certified` exists so an account on a certified STS vending system can be
 * recorded as such, and its vend requests refused, rather than being silently
 * vended with the wrong algorithm.
 */
export const prepaidTokenSchemeEnum = pgEnum('prepaid_token_scheme', [
  'openpaygo',
  'sts_certified',
]);

/** An account's supply state. `disconnected` is a decision, never an inference. */
export const prepaidAccountStatusEnum = pgEnum('prepaid_account_status', [
  'active',
  'suspended',
  'disconnected',
  'closed',
]);

export const prepaidTokenStatusEnum = pgEnum('prepaid_token_status', [
  /** Vended and handed to the customer; not yet known to have been entered. */
  'issued',
  /** A meter (or a meter simulator, in testing) accepted it. Single-use. */
  'redeemed',
  /** Vended but withdrawn before use, with a reason. Its count stays consumed. */
  'void',
]);

/**
 * Where a consumption row's energy came from. `meter_reset_gap` is a period whose
 * energy is unknown because the register moved backwards (a meter replacement, a
 * reset, or a re-serialised device); it carries zero energy and says why, instead
 * of charging the customer for a negative delta or silently ignoring the period.
 */
export const prepaidConsumptionSourceEnum = pgEnum('prepaid_consumption_source', [
  'meter_register',
  'meter_reset_gap',
]);

export const prepaidSupplyActionEnum = pgEnum('prepaid_supply_action', [
  'disconnect',
  'reconnect',
]);

export const prepaidSupplyReasonEnum = pgEnum('prepaid_supply_reason', [
  'credit_exhausted',
  'operator_request',
  'customer_request',
  'fault',
  'credit_restored',
]);

export const prepaidAccounts = pgTable(
  'prepaid_accounts',
  {
    id: serial('id').primaryKey(),
    /** The customer who owns the credit. Their money; their balance. */
    userId: int('user_id').notNull(),
    /**
     * The asset whose cumulative energy register measures this account's
     * consumption. Null means no meter integration: the account can be credited,
     * but the platform cannot say how much of that credit is left, and every read
     * of the balance says so instead of returning the credited figure as if it
     * were remaining.
     */
    meterAssetId: int('meter_asset_id'),
    /** The device identity a token is vended against, as printed on the meter. */
    meterSerial: varchar('meter_serial', { length: 64 }).notNull(),
    scheme: prepaidTokenSchemeEnum('scheme').notNull().default('openpaygo'),
    /**
     * How the device interprets a token's value — the agreement between this
     * vending record and the hardware (for example
     * `openpaygo/add-value:wh-divider`). Required, because a token whose units
     * nobody agreed on is a number, not credit.
     */
    deviceProfile: varchar('device_profile', { length: 160 }).notNull(),
    /**
     * The name of this device's secret key in the deployment keyring. The key
     * itself is never stored here: a database dump must not be enough to vend
     * energy on somebody's meter.
     */
    keyRef: varchar('key_ref', { length: 160 }).notNull(),
    /** OpenPAYGO starting code for the device (its factory token seed). */
    startingCode: bigint('starting_code', { mode: 'number' }).notNull(),
    /**
     * The OpenPAYGO count last vended for this device. Counts move forward only;
     * the device rejects a repeat, so this column is the vending sequence and is
     * advanced in the same transaction as the token that used it.
     */
    tokenCount: int('token_count').notNull().default(1),
    /**
     * Watt-hours per unit of a token's value, as the device is configured. A
     * purchase whose energy is not a whole multiple of this is refused rather
     * than rounded into or out of the customer's favour.
     */
    whPerValueUnit: int('wh_per_value_unit').notNull().default(1),
    /** Price of energy in whole minor currency units per kWh. */
    tariffMinorPerKwh: int('tariff_minor_per_kwh').notNull(),
    currency: ledgerCurrencyEnum('currency').notNull(),
    /** Whole watt-hours vended to this account, ever. Derived from the tokens. */
    creditedWh: bigint('credited_wh', { mode: 'number' }).notNull().default(0),
    /** Whole watt-hours measured as taken. Derived from the consumption rows. */
    consumedWh: bigint('consumed_wh', { mode: 'number' }).notNull().default(0),
    /** The last cumulative meter reading accounted for, and when it was taken. */
    meterRegisterWh: bigint('meter_register_wh', { mode: 'number' }),
    meterReadingAt: timestamp('meter_reading_at'),
    status: prepaidAccountStatusEnum('status').notNull().default('active'),
    openedAt: timestamp('opened_at').defaultNow().notNull(),
    openedBy: int('opened_by').notNull(),
    notes: varchar('notes', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('prepaid_accounts_meter_serial_key').on(table.meterSerial),
    index('prepaid_accounts_user_idx').on(table.userId),
    index('prepaid_accounts_meter_asset_idx').on(table.meterAssetId),
  ]
);

export const prepaidTokens = pgTable(
  'prepaid_tokens',
  {
    id: serial('id').primaryKey(),
    accountId: int('account_id').notNull(),
    /** The payment that bought this energy. No payment, no token. */
    paymentId: int('payment_id').notNull(),
    /**
     * Which token this is for that payment. Zero for the vend itself; a re-vend
     * (a customer who lost the code before entering it) increments it, so a
     * resend is distinguishable from a second purchase.
     */
    sequence: int('sequence').notNull().default(0),
    scheme: prepaidTokenSchemeEnum('scheme').notNull(),
    /** The digits the customer types into the meter. */
    tokenCode: varchar('token_code', { length: 64 }).notNull(),
    /** The OpenPAYGO count this token was vended at. Unique per account. */
    tokenCount: int('token_count').notNull(),
    /** OpenPAYGO token type name, e.g. `ADD_TIME` (add value) or `SET_TIME`. */
    tokenType: varchar('token_type', { length: 32 }).notNull(),
    /** Whole watt-hours this token credits. */
    energyWh: bigint('energy_wh', { mode: 'number' }).notNull(),
    /** The value carried in the token itself, in device units. */
    valueUnits: int('value_units').notNull(),
    amountMinor: int('amount_minor').notNull(),
    currency: ledgerCurrencyEnum('currency').notNull(),
    status: prepaidTokenStatusEnum('status').notNull().default('issued'),
    /** The provider's reference for the payment: the evidence money arrived. */
    providerReference: varchar('provider_reference', { length: 200 }).notNull(),
    /** The double-entry posting for the purchase, when one was made. */
    ledgerPostingId: int('ledger_posting_id'),
    issuedAt: timestamp('issued_at').defaultNow().notNull(),
    issuedBy: int('issued_by'),
    redeemedAt: timestamp('redeemed_at'),
    /** What proves the meter accepted it. Required to call it redeemed. */
    redemptionEvidenceRef: varchar('redemption_evidence_ref', { length: 200 }),
    voidReason: varchar('void_reason', { length: 200 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('prepaid_tokens_payment_sequence_key').on(
      table.accountId,
      table.paymentId,
      table.sequence
    ),
    uniqueIndex('prepaid_tokens_account_count_key').on(table.accountId, table.tokenCount),
    uniqueIndex('prepaid_tokens_account_code_key').on(table.accountId, table.tokenCode),
    index('prepaid_tokens_account_issued_idx').on(table.accountId, table.issuedAt),
  ]
);

export const prepaidConsumption = pgTable(
  'prepaid_consumption',
  {
    id: serial('id').primaryKey(),
    accountId: int('account_id').notNull(),
    fromAt: timestamp('from_at').notNull(),
    toAt: timestamp('to_at').notNull(),
    /** The two register readings the energy is the difference of. */
    registerStartWh: bigint('register_start_wh', { mode: 'number' }).notNull(),
    registerEndWh: bigint('register_end_wh', { mode: 'number' }).notNull(),
    energyWh: bigint('energy_wh', { mode: 'number' }).notNull(),
    source: prepaidConsumptionSourceEnum('source').notNull(),
    /** The telemetry rows this was measured from. */
    evidenceRef: varchar('evidence_ref', { length: 200 }).notNull(),
    detail: varchar('detail', { length: 300 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('prepaid_consumption_account_to_key').on(table.accountId, table.toAt),
    index('prepaid_consumption_account_idx').on(table.accountId, table.toAt),
  ]
);

export const prepaidSupplyEvents = pgTable(
  'prepaid_supply_events',
  {
    id: serial('id').primaryKey(),
    accountId: int('account_id').notNull(),
    action: prepaidSupplyActionEnum('action').notNull(),
    reason: prepaidSupplyReasonEnum('reason').notNull(),
    /** Null when the platform itself decided (credit exhausted). */
    actorUserId: int('actor_user_id'),
    /**
     * Whether a device confirmed the action. False is the honest default: the
     * platform decided, and without a meter integration nobody knows whether the
     * supply at the customer's premises actually changed.
     */
    enforcedAtMeter: boolean('enforced_at_meter').notNull().default(false),
    evidenceRef: varchar('evidence_ref', { length: 200 }),
    detail: varchar('detail', { length: 300 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('prepaid_supply_events_account_idx').on(table.accountId, table.createdAt)]
);

export type PrepaidAccountRow = typeof prepaidAccounts.$inferSelect;
export type InsertPrepaidAccount = typeof prepaidAccounts.$inferInsert;
export type PrepaidTokenRow = typeof prepaidTokens.$inferSelect;
export type InsertPrepaidToken = typeof prepaidTokens.$inferInsert;
export type PrepaidConsumptionRow = typeof prepaidConsumption.$inferSelect;
export type PrepaidSupplyEventRow = typeof prepaidSupplyEvents.$inferSelect;
export type PrepaidAccountStatus = (typeof prepaidAccountStatusEnum.enumValues)[number];
export type PrepaidTokenScheme = (typeof prepaidTokenSchemeEnum.enumValues)[number];
export type PrepaidTokenStatus = (typeof prepaidTokenStatusEnum.enumValues)[number];
export type PrepaidConsumptionSource = (typeof prepaidConsumptionSourceEnum.enumValues)[number];
export type PrepaidSupplyReason = (typeof prepaidSupplyReasonEnum.enumValues)[number];
