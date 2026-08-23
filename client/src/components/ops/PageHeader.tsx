import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The top of an operations page: what this screen is, what it is not, and the
 * controls that act on the whole screen.
 *
 * `caveat` is the line saying what the page's figures cannot establish — the one
 * sentence most likely to stop somebody trusting a screen further than they
 * should.
 */
export function PageHeader({
  title,
  description,
  caveat,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  caveat?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-wrap items-start justify-between gap-4",
        className
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">
            {description}
          </p>
        )}
        {caveat && (
          <p className="text-muted-foreground max-w-3xl border-l-2 border-amber-400/70 pl-3 text-xs leading-relaxed">
            {caveat}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
