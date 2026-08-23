/**
 * Who owns a Temporal workflow execution, decided from the id's own shape.
 *
 * A workflow execution carries its input — payment amounts, phone numbers,
 * counterparties — so reading one is a tenant boundary. Ownership used to be a
 * substring test for `-<userId>-`, which the id conventions in this repo do not
 * support: `auto-trading-7-42-1700000000` (user 7, asset 42) contains `-42-`, and
 * `payment-42` (payment id 42) contains no user id at all. The first grants user
 * 42 another member's workflow; the second is indistinguishable from an owned id.
 *
 * So ownership is parsed from the known id patterns by position, and an id that
 * matches none of them has *no* known owner: a non-admin is refused rather than
 * granted on a coincidence. That refusal is the safe direction — a member losing
 * sight of a workflow is an inconvenience, reading someone else's payment input is
 * a breach.
 */

/**
 * Patterns whose second segment group is the owning user id, as produced in
 * `server/routers/orchestrator.ts`.
 */
const OWNER_AFTER_PREFIX = [
  'auto-trading',
  'manual-trade',
  'p2p-trade',
  // `payment-user-<userId>-<epochMs>` from the member-facing orchestrator route.
  // The `user` segment is what separates it from `payment-<paymentId>`, which
  // encodes a payment row id and no owner at all; that shape stays unowned, so a
  // payment id that happens to equal a user id grants nothing.
  'payment-user',
] as const;

/**
 * `notification-<epochMs>-<userId>` from `server/integration/temporal-client.ts`
 * puts the user last instead.
 */
const OWNER_LAST_PREFIX = ['notification'] as const;

function positiveInt(segment: string | undefined): number | null {
  if (segment === undefined || !/^[0-9]+$/.test(segment)) return null;
  const parsed = Number(segment);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The owning user id, or `null` when the id does not encode one. `null` means
 * unknown — never "anyone".
 */
export function workflowOwnerId(workflowId: string): number | null {
  const id = workflowId.trim();
  if (id === '') return null;

  for (const prefix of OWNER_AFTER_PREFIX) {
    if (id.startsWith(`${prefix}-`)) {
      return positiveInt(id.slice(prefix.length + 1).split('-')[0]);
    }
  }

  for (const prefix of OWNER_LAST_PREFIX) {
    if (id.startsWith(`${prefix}-`)) {
      const segments = id.split('-');
      return positiveInt(segments[segments.length - 1]);
    }
  }

  return null;
}

/** True only when this workflow id demonstrably belongs to this user. */
export function ownsWorkflow(workflowId: string, userId: number): boolean {
  return workflowOwnerId(workflowId) === userId;
}
