import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A titled panel with room for controls and an evidence footer.
 *
 * Operations pages are read in a hurry, so the title, the state and the
 * qualification belong in fixed positions on every panel rather than wherever
 * each page put them.
 */
export function PanelCard({
  title,
  description,
  actions,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** What the panel's figures do *not* establish, kept in one place. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "bg-card flex flex-col rounded-xl border shadow-sm",
        className
      )}
      aria-label={typeof title === "string" ? title : undefined}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base leading-none font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>

      <div className={cn("px-5 py-4", bodyClassName)}>{children}</div>

      {footer && (
        <footer className="text-muted-foreground bg-muted/40 rounded-b-xl border-t px-5 py-3 text-xs leading-relaxed">
          {footer}
        </footer>
      )}
    </section>
  );
}
