import { freshness } from "@/lib/tone";
import { ToneBadge } from "./ToneBadge";

/**
 * The age of the evidence behind a figure, next to the figure.
 *
 * Operations screens refresh themselves, which makes every number look current;
 * this is what says otherwise. It renders `never observed` rather than hiding,
 * because an empty slot reads as "nothing to report" when it means "we do not
 * know".
 */
export function FreshnessBadge({
  asOf,
  stalenessSeconds,
  className,
}: {
  asOf: Date | string | number | null | undefined;
  /** How long a reading of this kind stays current — the domain decides. */
  stalenessSeconds: number;
  className?: string;
}) {
  const state = freshness(asOf, stalenessSeconds);

  return (
    <ToneBadge
      label={state.label}
      tone={state.tone}
      meaning={state.meaning}
      className={className}
    />
  );
}
