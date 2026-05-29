import type { ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "./ui/button";

/**
 * Compact, non-full-screen error view used as the `errorComponent` for
 * route segments below the root. Lets the sidebar / shell stay mounted
 * (composer drafts, connection status, sidebar nav) when a leaf route
 * throws — only the inside of that segment is replaced with this card.
 *
 * Root-level crashes still go to the full-bleed `RootRouteErrorView`
 * in `__root.tsx`.
 */
export function RouteErrorPanel({ error, reset }: ErrorComponentProps) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : "An unexpected error occurred while rendering this page.";

  const stack = error instanceof Error ? error.stack ?? "" : "";

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center px-4 py-6">
      <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-card p-5 shadow-md">
        <div className="flex items-start gap-2.5">
          <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">This view crashed.</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              The rest of T3 is still running — your sidebar, composer, and
              other threads are unaffected.
            </p>
            <p className="mt-2 break-words text-xs font-mono text-red-700">{message}</p>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button size="sm" onClick={() => reset()} className="gap-1.5">
            <RefreshCwIcon className="size-3.5" />
            Retry
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>
        {stack ? (
          <details className="mt-3 rounded-md border border-border bg-background/50">
            <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-muted-foreground">
              Stack trace
            </summary>
            <pre className="max-h-40 overflow-auto border-t border-border bg-background px-2 py-1.5 text-[10px] leading-snug text-foreground/80">
              {stack}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
