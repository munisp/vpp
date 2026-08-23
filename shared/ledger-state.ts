/**
 * Copy for the double-entry ledger, shared by the PWA and the React Native app so
 * one wording of "the ledger never confirmed this" exists rather than two.
 *
 * The distinctions the wording has to keep: an entry the ledger refused is a
 * finding about the money, an entry it never answered is missing information, and
 * a deployment with no ledger has no balance at all — none of the three may read
 * as a settled movement.
 */

export type LedgerPostingState = 'pending' | 'posted' | 'refused' | 'unavailable_no_ledger';
export type ReconciliationVerdict = 'matched' | 'mismatch' | 'unknown';
export type Tone = 'good' | 'warning' | 'danger' | 'neutral';

export interface MemberReconciliation {
  userId: number;
  currency: string;
  ledgerBalanceMinor: number | null;
  postedBalanceMinor: number;
  businessBalanceMinor: number;
  unconfirmedMinor: number;
  verdict: ReconciliationVerdict;
  note: string;
}

export interface LedgerPosting {
  id: number;
  postingKind: string;
  sourceType: string;
  sourceId: number;
  providerReference: string | null;
  currency: string;
  amountMinor: number;
  state: LedgerPostingState;
  detail: string | null;
  createdAt: string | Date;
}

export const POSTING_STATE_COPY: Record<LedgerPostingState, { label: string; tone: Tone; meaning: string }> = {
  posted: {
    label: 'On the ledger',
    tone: 'good',
    meaning: 'The ledger applied this entry, so both sides of the movement are on its balances.',
  },
  pending: {
    label: 'Not confirmed',
    tone: 'warning',
    meaning:
      'The platform recorded the movement but the ledger has not confirmed it. It will be retried; until then no balance reflects it.',
  },
  refused: {
    label: 'Refused',
    tone: 'danger',
    meaning:
      'The ledger refused this entry — commonly a payout larger than the amount owed. No balance changed and the movement needs an operator.',
  },
  unavailable_no_ledger: {
    label: 'No ledger',
    tone: 'danger',
    meaning:
      'This deployment has no double-entry ledger configured, so the movement is recorded but no balance can be asserted for it.',
  },
};

export const VERDICT_COPY: Record<ReconciliationVerdict, { label: string; tone: Tone; meaning: string }> = {
  matched: {
    label: 'Agrees',
    tone: 'good',
    meaning: 'The ledger, the platform\u2019s postings and the settlements shown to the member all agree.',
  },
  mismatch: {
    label: 'Mismatch',
    tone: 'danger',
    meaning:
      'Two records of the same money disagree. Nothing has been changed to make them agree: one of them is wrong and a human has to say which.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'warning',
    meaning:
      'The member\u2019s ledger balance could not be read. This is missing information, not a balance of zero.',
  },
};

export const POSTING_KIND_LABELS: Record<string, string> = {
  buyer_payment_captured: 'Buyer payment captured',
  member_payout_settled: 'Member payout settled',
  buyer_payment_reversed: 'Buyer payment reversed',
};

export function postingKindLabel(kind: string): string {
  return POSTING_KIND_LABELS[kind] ?? kind;
}

/** Minor units as a readable amount. The ledger holds integers; this only formats. */
export function formatMinor(minor: number | null, currency: string): string {
  if (minor === null) return 'unknown';
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')} ${currency}`;
}

export interface ReconciliationSummary {
  members: number;
  matched: number;
  mismatches: number;
  unknowns: number;
  unconfirmedMinor: number;
}

export function summariseReconciliation(members: MemberReconciliation[]): ReconciliationSummary {
  return {
    members: members.length,
    matched: members.filter(member => member.verdict === 'matched').length,
    mismatches: members.filter(member => member.verdict === 'mismatch').length,
    unknowns: members.filter(member => member.verdict === 'unknown').length,
    unconfirmedMinor: members.reduce((total, member) => total + member.unconfirmedMinor, 0),
  };
}

/**
 * The headline. A mismatch outranks everything else, and "nothing to reconcile" is
 * never phrased as agreement — an empty ledger agrees with nothing.
 */
export function reconciliationHeadline(
  summary: ReconciliationSummary,
  configured: boolean
): { text: string; tone: Tone } {
  if (!configured) {
    return { text: 'No double-entry ledger is configured', tone: 'danger' };
  }
  if (summary.members === 0) {
    return { text: 'No member holds a ledger account yet', tone: 'neutral' };
  }
  if (summary.mismatches > 0) {
    return {
      text: `${summary.mismatches} of ${summary.members} member balances disagree`,
      tone: 'danger',
    };
  }
  if (summary.unknowns > 0) {
    return {
      text: `${summary.unknowns} member balances could not be read`,
      tone: 'warning',
    };
  }
  return { text: `All ${summary.members} member balances agree`, tone: 'good' };
}
