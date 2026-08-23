/**
 * Shared vocabulary for rolling fleet aggregates in the UI.
 *
 * An aggregate over a fleet where half the assets went dark looks identical to
 * an aggregate over a smaller fleet, so every figure on screen is shown next to
 * how much of the fleet it saw. Coverage is stated as a share of *rated
 * capacity*, not a share of asset count: ten silent 200 W panels and one silent
 * 20 kWh battery are not the same blind spot.
 */

export type CoverageTone = 'good' | 'warning' | 'danger' | 'neutral';

export interface FleetBucket {
  bucketStartsAt: string | Date;
  bucketMinutes: number;
  state: 'open' | 'closed';
  meanNetPowerWatts: number;
  integratedEnergyWh: number;
  expectedAssets: number;
  reportingAssets: number;
  silentAssets: number;
  samples: number;
  reportingCapacityWh: number;
  silentCapacityWh: number;
  socKnownAssets: number;
  socUnknownAssets: number;
  availableEnergyWh: number;
  computedAt: string | Date;
}

export interface CoverageVerdict {
  label: string;
  tone: CoverageTone;
  meaning: string;
  /** Reporting share of rated capacity, 0-1, or null when nothing is in scope. */
  capacityShare: number | null;
}

/**
 * How much of the scope this bucket actually saw.
 *
 * Deliberately harsh: anything under 90% of rated capacity reporting is called
 * out, because a number sold to a grid operator carries the whole blind spot as
 * risk, not the average of it.
 */
export function coverageVerdict(bucket: FleetBucket): CoverageVerdict {
  if (bucket.expectedAssets === 0) {
    return {
      label: 'Nothing in scope',
      tone: 'neutral',
      meaning: 'No active assets belong to this scope, so there is nothing to aggregate.',
      capacityShare: null,
    };
  }

  const ratedWh = bucket.reportingCapacityWh + bucket.silentCapacityWh;
  const capacityShare = ratedWh > 0 ? bucket.reportingCapacityWh / ratedWh : 0;

  if (bucket.reportingAssets === 0) {
    return {
      label: 'Nothing reported',
      tone: 'danger',
      meaning: `All ${bucket.expectedAssets} assets in scope were silent. This bucket measures nothing; it is not a quiet fleet.`,
      capacityShare,
    };
  }
  if (capacityShare >= 0.99) {
    return {
      label: 'Full coverage',
      tone: 'good',
      meaning: 'Every asset in scope reported at least once in this bucket.',
      capacityShare,
    };
  }
  const missingPct = (1 - capacityShare) * 100;
  return {
    label: `${(capacityShare * 100).toFixed(0)}% of rated capacity seen`,
    tone: capacityShare >= 0.9 ? 'warning' : 'danger',
    meaning:
      `${bucket.silentAssets} of ${bucket.expectedAssets} assets reported nothing, ` +
      `hiding ${formatKwh(bucket.silentCapacityWh)} of rated capacity ` +
      `(${missingPct.toFixed(0)}% of the scope). The measured figures cover the rest only.`,
    capacityShare,
  };
}

export const BUCKET_STATE_COPY: Record<'open' | 'closed', { label: string; tone: CoverageTone; meaning: string }> = {
  open: {
    label: 'Still filling',
    tone: 'warning',
    meaning:
      'This bucket has not elapsed. Late telemetry will change it, so it is not evidence yet.',
  },
  closed: {
    label: 'Closed',
    tone: 'good',
    meaning: 'The bucket has elapsed. It is recomputed only if telemetry arrives late.',
  },
};

/** kWh magnitude without a direction, for capacity. */
export function formatKwh(wattHours: number): string {
  return `${(wattHours / 1000).toFixed(1)} kWh`;
}

/** Generation-positive telemetry, phrased by direction. */
export function formatFleetKw(watts: number): string {
  if (watts === 0) return '0.00 kW';
  return `${(Math.abs(watts) / 1000).toFixed(2)} kW ${watts > 0 ? 'generating' : 'consuming'}`;
}

export function formatFleetKwh(wattHours: number): string {
  if (wattHours === 0) return '0.00 kWh';
  return `${(Math.abs(wattHours) / 1000).toFixed(2)} kWh ${wattHours > 0 ? 'generated' : 'consumed'}`;
}

/**
 * Available stored energy, with the batteries it could not see named.
 *
 * A battery that reported no state of charge contributes nothing here, so this
 * is a floor on what the fleet holds, never an estimate of it.
 */
export function describeAvailableEnergy(bucket: FleetBucket): { label: string; meaning: string; tone: CoverageTone } {
  const label = formatKwh(bucket.availableEnergyWh);
  if (bucket.socUnknownAssets === 0) {
    return {
      label,
      tone: 'good',
      meaning: 'Every battery in scope reported a state of charge in this bucket.',
    };
  }
  return {
    label: `≥ ${label}`,
    tone: bucket.socKnownAssets === 0 ? 'danger' : 'warning',
    meaning:
      `${bucket.socUnknownAssets} batter${bucket.socUnknownAssets === 1 ? 'y' : 'ies'} reported no state of charge ` +
      'and contribute nothing to this figure, so it is a floor rather than an estimate.',
  };
}

/**
 * Series-level summary for the header.
 *
 * `missingBuckets` is a fact about the rollup, not about the fleet: a stalled
 * rollup must not read as an idle fleet, so it gets its own line.
 */
export function summariseSeries(
  buckets: FleetBucket[],
  missingBuckets: number
): {
  closedBuckets: number;
  openBuckets: number;
  missingBuckets: number;
  /** Worst reporting share of rated capacity across closed buckets. */
  worstCapacityShare: number | null;
  bucketsWithSilence: number;
  latest: FleetBucket | null;
} {
  let closedBuckets = 0;
  let openBuckets = 0;
  let worstCapacityShare: number | null = null;
  let bucketsWithSilence = 0;

  for (const bucket of buckets) {
    if (bucket.state === 'closed') closedBuckets += 1;
    else openBuckets += 1;
    if (bucket.silentAssets > 0) bucketsWithSilence += 1;
    if (bucket.state === 'closed') {
      const verdict = coverageVerdict(bucket);
      if (
        verdict.capacityShare !== null &&
        (worstCapacityShare === null || verdict.capacityShare < worstCapacityShare)
      ) {
        worstCapacityShare = verdict.capacityShare;
      }
    }
  }

  return {
    closedBuckets,
    openBuckets,
    missingBuckets,
    worstCapacityShare,
    bucketsWithSilence,
    latest: buckets.length > 0 ? buckets[buckets.length - 1] : null,
  };
}
