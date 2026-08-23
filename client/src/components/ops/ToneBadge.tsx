import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TONE_BADGE, TONE_DOT, type StateTone } from "@/lib/tone";

/**
 * A state, in the one colour that state has anywhere in the product, with the
 * sentence explaining what it means one hover away. A tone with no explanation
 * is a colour an operator has to guess at, so `meaning` is strongly encouraged.
 */
export function ToneBadge({
  label,
  tone,
  meaning,
  dot = true,
  className,
}: {
  label: string;
  tone: StateTone;
  meaning?: string;
  dot?: boolean;
  className?: string;
}) {
  const badge = (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_BADGE[tone],
        className
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            TONE_DOT[tone],
            tone === "live" && "motion-safe:animate-pulse"
          )}
        />
      )}
      {label}
    </span>
  );

  if (!meaning) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{badge}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">
          {meaning}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
