import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { TONE_ACCENT, TONE_TEXT, type StateTone } from "@/lib/tone";
import { Sparkline, type SparkPoint } from "./Sparkline";
import { ToneBadge } from "./ToneBadge";

/**
 * One figure, its unit, the evidence behind it, and its trend.
 *
 * `value` is a string the caller has already formatted, because rounding a
 * measurement is a domain decision. When there is nothing to show, pass
 * `value={null}` and it renders as unknown — a tile is never allowed to print
 * `0` for a measurement that was not taken.
 */
export function MetricTile({
  label,
  value,
  unit,
  tone = "neutral",
  status,
  evidence,
  trend,
  className,
}: {
  label: string;
  value: string | null;
  unit?: string;
  tone?: StateTone;
  /** Short state pill, e.g. a coverage verdict or posture. */
  status?: { label: string; tone: StateTone; meaning?: string };
  /** Freshness badge, coverage note, or anything qualifying the figure. */
  evidence?: ReactNode;
  trend?: { points: SparkPoint[]; tone?: StateTone };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card relative flex flex-col gap-3 overflow-hidden rounded-xl border border-l-3 p-4 shadow-sm transition-shadow hover:shadow-md",
        TONE_ACCENT[tone],
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </p>
        {status && (
          <ToneBadge
            label={status.label}
            tone={status.tone}
            meaning={status.meaning}
            dot={false}
          />
        )}
      </div>

      <div className="flex items-baseline gap-1.5">
        {value === null ? (
          <span className="text-muted-foreground text-xl font-medium">
            unknown
          </span>
        ) : (
          <>
            <span
              className={cn(
                "text-3xl leading-none font-semibold tabular-nums tracking-tight",
                tone === "neutral" ? "text-foreground" : TONE_TEXT[tone]
              )}
            >
              {value}
            </span>
            {unit && (
              <span className="text-muted-foreground text-sm font-medium">
                {unit}
              </span>
            )}
          </>
        )}
      </div>

      {trend && (
        <Sparkline
          points={trend.points}
          tone={trend.tone ?? tone}
          ariaLabel={label}
        />
      )}

      {evidence && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {evidence}
        </div>
      )}
    </div>
  );
}
