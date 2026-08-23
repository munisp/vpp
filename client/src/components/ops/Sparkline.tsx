import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { TONE_STROKE, type StateTone } from "@/lib/tone";

export interface SparkPoint {
  /** `null` is a gap in the series — a bucket nothing was measured for. */
  value: number | null;
}

/**
 * A trend behind a metric, with gaps drawn as gaps.
 *
 * Recharts connects across nulls by default, which turns an outage into a
 * straight line through it: `connectNulls` stays off here so a hole in the data
 * looks like a hole.
 */
export function Sparkline({
  points,
  tone = "live",
  height = 40,
  ariaLabel,
}: {
  points: SparkPoint[];
  tone?: StateTone;
  height?: number;
  ariaLabel?: string;
}) {
  if (points.length < 2) {
    return (
      <div
        className="text-muted-foreground flex items-center text-[11px]"
        style={{ height }}
        role="img"
        aria-label={ariaLabel ?? "not enough history to plot"}
      >
        not enough history to plot
      </div>
    );
  }

  const colour = TONE_STROKE[tone];
  const gradientId = `spark-${tone}`;

  return (
    <div style={{ height }} role="img" aria-label={ariaLabel ?? "trend"}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={points}
          margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colour} stopOpacity={0.35} />
              <stop offset="100%" stopColor={colour} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={colour}
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
