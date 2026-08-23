/**
 * Shared vocabulary for located flexibility in the UI.
 *
 * A flexibility award is a paid promise about a *place*, so the screens must keep
 * four different things apart, because they look alike on a dashboard and are
 * worth different money:
 *  - rated capacity behind a node (paper), versus awarded capacity (a promise)
 *  - an award (a promise), versus measured delivery (evidence)
 *  - a measurement that failed for want of telemetry (`unverified`), versus one
 *    that showed no reduction (`not_delivered`)
 *  - a measured delivery, versus a settled one
 */

export type FlexibilityTone = 'good' | 'warning' | 'danger' | 'neutral';

export type FlexibilityDirection = 'import_reduction' | 'export_reduction';

export type NodeLinkSource = 'operator_declared' | 'utility_verified' | 'unverified';

export type DeliveryStatus =
  | 'unmeasured'
  | 'delivered'
  | 'partial'
  | 'not_delivered'
  | 'unverified';

/** Cents per kWh are stored scaled by 100, like every other price on the platform. */
export const PRICE_SCALE = 100;

export const DIRECTION_COPY: Record<FlexibilityDirection, { label: string; meaning: string }> = {
  import_reduction: {
    label: 'Reduce import',
    meaning:
      'The node needs less power drawn through it: consume less, or generate/discharge more. Measured as power rising above the asset baseline.',
  },
  export_reduction: {
    label: 'Reduce export',
    meaning:
      'The node needs less power pushed back through it: generate/discharge less, or absorb more. Measured as power falling below the asset baseline.',
  },
};

export const LINK_SOURCE_COPY: Record<
  NodeLinkSource,
  { label: string; tone: FlexibilityTone; meaning: string }
> = {
  utility_verified: {
    label: 'Utility verified',
    tone: 'good',
    meaning:
      'The network operator confirmed this asset sits behind the node, with evidence recorded against the link.',
  },
  operator_declared: {
    label: 'Operator declared',
    tone: 'warning',
    meaning:
      'An operator recorded this asset behind the node without utility evidence. It can be awarded, but the location itself is an assertion.',
  },
  unverified: {
    label: 'Unverified',
    tone: 'danger',
    meaning:
      'Nobody has confirmed which node this asset is behind, so its relief cannot be sold here. The capacity is listed, never awarded.',
  },
};

export const DELIVERY_STATUS_COPY: Record<
  DeliveryStatus,
  { label: string; tone: FlexibilityTone; meaning: string }
> = {
  unmeasured: {
    label: 'Not measured yet',
    tone: 'neutral',
    meaning:
      'The award exists but delivery has not been measured. An award is a promise, never evidence that anything happened.',
  },
  delivered: {
    label: 'Delivered',
    tone: 'good',
    meaning:
      'Telemetry from this asset shows the full awarded reduction against its own baseline for the window.',
  },
  partial: {
    label: 'Partial',
    tone: 'warning',
    meaning:
      'Telemetry shows a real reduction, but less than the award. Payment follows the measured energy, not the award.',
  },
  not_delivered: {
    label: 'Not delivered',
    tone: 'danger',
    meaning:
      'Telemetry covered the window and shows no reduction in the direction asked for. This is measured non-performance, and pays nothing.',
  },
  unverified: {
    label: 'Unverified',
    tone: 'danger',
    meaning:
      'There was not enough telemetry to judge this window, so delivery is unknown — neither performance nor breach. It cannot be settled.',
  },
};

/** Statuses a settlement may be created from. Everything else is refused. */
export const SETTLEABLE_STATUSES: DeliveryStatus[] = ['delivered', 'partial'];

export function canSettle(award: { deliveryStatus: DeliveryStatus; settled: boolean }): boolean {
  return !award.settled && SETTLEABLE_STATUSES.includes(award.deliveryStatus);
}

export const REQUIREMENT_STATUS_COPY: Record<
  string,
  { label: string; tone: FlexibilityTone; meaning: string }
> = {
  open: {
    label: 'Open',
    tone: 'neutral',
    meaning: 'Accepting offers. Nothing is committed until the requirement clears.',
  },
  cleared: {
    label: 'Cleared',
    tone: 'good',
    meaning: 'Eligible offers covered the requirement in merit order and were awarded.',
  },
  short: {
    label: 'Short',
    tone: 'danger',
    meaning:
      'Clearing ran out of eligible capacity: the node got less relief than it asked for. Awards below are real, but the requirement was not met.',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
    meaning: 'The operator withdrew the requirement. No awards stand.',
  },
  settled: {
    label: 'Settled',
    tone: 'good',
    meaning: 'Every measured award on this requirement has been paid into the ledger.',
  },
};

export function requirementStatusCopy(status: string) {
  return (
    REQUIREMENT_STATUS_COPY[status] ?? {
      label: status,
      tone: 'neutral' as FlexibilityTone,
      meaning: 'Unrecognised status.',
    }
  );
}

export function formatKw(watts: number): string {
  return `${(watts / 1000).toFixed(2)} kW`;
}

export function formatKwh(wattHours: number): string {
  return `${(wattHours / 1000).toFixed(2)} kWh`;
}

/** Scaled cents per kWh back into a readable price. */
export function formatPrice(scaledCentsPerKwh: number, currency: string): string {
  return `${(scaledCentsPerKwh / PRICE_SCALE).toFixed(2)} ${currency}/kWh`;
}

/**
 * How much of the requirement was actually covered by awards.
 *
 * Kept separate from delivery on purpose: a fully cleared requirement whose
 * assets all went silent covered 100% on paper and delivered nothing.
 */
export function clearedShare(requirement: {
  requiredPowerW: number;
  clearedPowerW: number;
}): number | null {
  if (requirement.requiredPowerW <= 0) return null;
  return requirement.clearedPowerW / requirement.requiredPowerW;
}

/**
 * One line describing what a requirement is really worth to the network.
 *
 * Unverified awards are called out separately from a shortfall, because an
 * operator planning around this node needs to know whether the relief is absent
 * or merely unproven.
 */
export function describeRequirementCoverage(requirement: {
  status: string;
  requiredPowerW: number;
  clearedPowerW: number;
  awards: number;
  unverifiedAwards: number;
  ineligibleOffers: number;
}): { label: string; tone: FlexibilityTone; meaning: string } {
  const share = clearedShare(requirement);
  const parts: string[] = [];

  if (requirement.ineligibleOffers > 0) {
    parts.push(
      `${requirement.ineligibleOffers} offer${requirement.ineligibleOffers === 1 ? '' : 's'} could not be awarded (location or eligibility)`
    );
  }
  if (requirement.unverifiedAwards > 0) {
    parts.push(
      `${requirement.unverifiedAwards} of ${requirement.awards} award${requirement.awards === 1 ? '' : 's'} has no measurable delivery`
    );
  }

  if (requirement.status === 'open') {
    return {
      label: 'Awaiting clearing',
      tone: 'neutral',
      meaning: parts.length > 0 ? parts.join('; ') : 'Offers are still being collected.',
    };
  }

  if (share === null) {
    return { label: '—', tone: 'neutral', meaning: parts.join('; ') };
  }

  const pct = `${(share * 100).toFixed(0)}% of the requirement awarded`;
  if (requirement.status === 'short') {
    return {
      label: pct,
      tone: 'danger',
      meaning: [
        `Only ${formatKw(requirement.clearedPowerW)} of ${formatKw(requirement.requiredPowerW)} was covered by eligible capacity.`,
        ...parts,
      ].join(' '),
    };
  }
  return {
    label: pct,
    tone: requirement.unverifiedAwards > 0 ? 'warning' : 'good',
    meaning:
      parts.length > 0
        ? parts.join('; ')
        : 'Eligible offers covered the requirement and every award was measurable.',
  };
}

/**
 * What an award is worth as evidence, phrased so a promise never reads as proof.
 */
export function describeAwardEvidence(award: {
  deliveryStatus: DeliveryStatus;
  awardedPowerW: number;
  deliveredPowerW: number | null;
  deliveredEnergyWh: number | null;
  measuredSamples: number;
  unverifiedReason: string | null;
  settled: boolean;
}): { label: string; tone: FlexibilityTone; meaning: string } {
  const copy = DELIVERY_STATUS_COPY[award.deliveryStatus];

  if (award.deliveryStatus === 'unverified') {
    return {
      ...copy,
      meaning: award.unverifiedReason
        ? `${copy.meaning} ${award.unverifiedReason}.`
        : copy.meaning,
    };
  }

  if (award.deliveryStatus === 'partial' || award.deliveryStatus === 'delivered') {
    const measured =
      award.deliveredPowerW === null ? '—' : formatKw(award.deliveredPowerW);
    const energy =
      award.deliveredEnergyWh === null ? '—' : formatKwh(award.deliveredEnergyWh);
    return {
      label: award.settled ? `${copy.label} · settled` : copy.label,
      tone: copy.tone,
      meaning:
        `${copy.meaning} Measured ${measured} against an award of ${formatKw(award.awardedPowerW)} ` +
        `across ${award.measuredSamples} telemetry sample${award.measuredSamples === 1 ? '' : 's'}, ` +
        `credited ${energy}.`,
    };
  }

  return copy;
}

/**
 * Rated capacity behind a node is not availability.
 *
 * The headroom view exists to plan with, so it must say plainly that these watts
 * are nameplate ratings of assets that may be silent, empty or busy.
 */
export function describeNodeCapacity(node: {
  awardableRatedW: number;
  unverifiedRatedW: number;
  linkedAssets: number;
  unverifiedAssets: number;
  /**
   * Assets behind the awardable watts. Reported by the server on the same
   * condition it sums the watts on, because a verified link on an inactive asset
   * is linked without being awardable.
   */
  awardableAssets: number;
}): { label: string; tone: FlexibilityTone; meaning: string } {
  if (node.linkedAssets === 0) {
    return {
      label: 'No assets linked',
      tone: 'neutral',
      meaning: 'No asset has been recorded behind this node, so nothing can be offered here.',
    };
  }
  const base = `${formatKw(node.awardableRatedW)} rated across ${node.awardableAssets} awardable asset${node.awardableAssets === 1 ? '' : 's'}. Nameplate ratings, not measured availability.`;
  if (node.unverifiedAssets === 0) {
    return { label: formatKw(node.awardableRatedW), tone: 'good', meaning: base };
  }
  return {
    label: formatKw(node.awardableRatedW),
    tone: 'warning',
    meaning:
      `${base} A further ${formatKw(node.unverifiedRatedW)} sits behind ${node.unverifiedAssets} unverified link${node.unverifiedAssets === 1 ? '' : 's'} ` +
      'and cannot be awarded until the location is confirmed.',
  };
}
