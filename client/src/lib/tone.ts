/**
 * One vocabulary for "how should this read on screen".
 *
 * Every operations page had grown its own tone→class map, so the same state was
 * amber on one page and grey on the next, and a page author had to decide what a
 * colour meant. The maps here are the only ones: a tone is chosen by the domain
 * module that knows the semantics (control state, coverage, capability posture)
 * and rendered identically everywhere.
 *
 * `live` is deliberately distinct from `good`: green means "this is what the
 * evidence says", pulsing cyan means "the evidence arrived just now". A figure
 * whose evidence is old must never be able to borrow either.
 */

export type StateTone = 'live' | 'good' | 'warning' | 'danger' | 'neutral';

/** Badge/pill surfaces, readable in both themes. */
export const TONE_BADGE: Record<StateTone, string> = {
  live: 'bg-cyan-100 text-cyan-900 border-cyan-300 dark:bg-cyan-950 dark:text-cyan-200 dark:border-cyan-800',
  good: 'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800',
  warning:
    'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800',
  danger:
    'bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-200 dark:border-red-800',
  neutral: 'bg-muted text-muted-foreground border-border',
};

/** Small status dots and legend swatches. */
export const TONE_DOT: Record<StateTone, string> = {
  live: 'bg-cyan-500',
  good: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  neutral: 'bg-muted-foreground/50',
};

/** Numerals and labels drawn straight onto a panel. */
export const TONE_TEXT: Record<StateTone, string> = {
  live: 'text-cyan-600 dark:text-cyan-300',
  good: 'text-emerald-600 dark:text-emerald-300',
  warning: 'text-amber-600 dark:text-amber-300',
  danger: 'text-red-600 dark:text-red-300',
  neutral: 'text-muted-foreground',
};

/** Panel edges and accent bars. */
export const TONE_ACCENT: Record<StateTone, string> = {
  live: 'border-cyan-400/60 dark:border-cyan-500/40',
  good: 'border-emerald-400/60 dark:border-emerald-500/40',
  warning: 'border-amber-400/70 dark:border-amber-500/50',
  danger: 'border-red-400/70 dark:border-red-500/50',
  neutral: 'border-border',
};

/** Series colour for charts, so a chart agrees with the badge above it. */
export const TONE_STROKE: Record<StateTone, string> = {
  live: 'var(--color-cyan-500)',
  good: 'var(--color-emerald-500)',
  warning: 'var(--color-amber-500)',
  danger: 'var(--color-red-500)',
  neutral: 'var(--color-muted-foreground)',
};

/** Ordered worst-first, for reducing many tones to the one that should be read. */
const SEVERITY: StateTone[] = ['danger', 'warning', 'neutral', 'good', 'live'];

/**
 * The tone a summary should take: the worst of its parts. An operator glancing
 * at a rolled-up figure must see the problem inside it, not its average.
 */
export function worstTone(tones: StateTone[]): StateTone {
  for (const tone of SEVERITY) {
    if (tones.includes(tone)) return tone;
  }
  return 'neutral';
}

export interface Freshness {
  tone: StateTone;
  /** Short label for a badge, e.g. `live · 4s ago`. */
  label: string;
  /** Full sentence for a tooltip: what is and is not known. */
  meaning: string;
  ageSeconds: number | null;
  /** True when the evidence is older than its bound, or absent entirely. */
  stale: boolean;
}

const NEVER: Freshness = {
  tone: 'neutral',
  label: 'never observed',
  meaning:
    'Nothing has been recorded for this yet. The figure is absent, not zero — an absent measurement and a measured zero are different things.',
  ageSeconds: null,
  stale: true,
};

export function formatAge(seconds: number): string {
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Grades an observation by its own staleness bound.
 *
 * Inside the bound the reading stands on its own evidence; past it the reading
 * is still shown — hiding it would leave a panel looking calm — but it is
 * labelled with its age, so nobody acts on a measurement from an hour ago as if
 * a device had just reported it. A timestamp from the future is reported as
 * clock skew rather than treated as the freshest reading available.
 */
export function freshness(
  asOf: Date | string | number | null | undefined,
  stalenessSeconds: number,
  now: Date = new Date()
): Freshness {
  if (asOf === null || asOf === undefined || asOf === '') return NEVER;

  const observed = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(observed.getTime())) return NEVER;

  const ageSeconds = (now.getTime() - observed.getTime()) / 1000;

  if (ageSeconds < -60) {
    return {
      tone: 'warning',
      label: 'clock skew',
      meaning:
        'This observation is timestamped in the future, so its age cannot be judged: either the reporting device or this platform has the wrong clock.',
      ageSeconds,
      stale: true,
    };
  }

  const age = Math.max(0, ageSeconds);
  const label = formatAge(age);

  if (age <= stalenessSeconds) {
    return {
      tone: 'live',
      label: `live · ${label}`,
      meaning: `Observed ${label}, within the ${formatAge(stalenessSeconds).replace(' ago', '')} this figure is considered current for.`,
      ageSeconds: age,
      stale: false,
    };
  }

  const badlyStale = age > stalenessSeconds * 3;

  return {
    tone: badlyStale ? 'danger' : 'warning',
    label: `stale · ${label}`,
    meaning: `Last observed ${label}, past the ${formatAge(stalenessSeconds).replace(' ago', '')} this figure is current for${badlyStale ? ' by more than three times over' : ''}. It is the last thing that was measured, not what is happening now.`,
    ageSeconds: age,
    stale: true,
  };
}
