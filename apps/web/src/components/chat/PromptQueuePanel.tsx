import { useState } from "react";
import { cn } from "~/lib/utils";
import type { QueuedPrompt } from "~/hooks/usePromptQueue";

/**
 * Compact panel rendered above the composer when prompts are queued (and/or
 * when the agent is running with text in the composer so the user has a
 * "Queue this" affordance). Collapses to a single line "Queued: 3" pill;
 * tap to expand into the full editable list with [×] per item and "Clear".
 */

interface PromptQueuePanelProps {
  readonly items: readonly QueuedPrompt[];
  /** True when the user currently has text in the composer and the agent is
   *  running — used to show the "Queue this" CTA inside the panel. */
  readonly canQueueCurrent: boolean;
  readonly onQueueCurrent: () => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
}

export function PromptQueuePanel({
  items,
  canQueueCurrent,
  onQueueCurrent,
  onRemove,
  onClear,
}: PromptQueuePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const hasItems = items.length > 0;
  // Nothing to render — no queued items AND no opportunity to queue the
  // current draft. The parent will already gate on this in most cases, but
  // we keep the guard here so the component is safe to drop into any tree.
  if (!hasItems && !canQueueCurrent) return null;

  return (
    <div
      className={cn(
        "mb-2 rounded-2xl border border-border bg-card/60 text-xs",
        // Collapsed state is a thin pill; expanded mode gets more room.
        expanded ? "p-2" : "px-3 py-1.5",
      )}
      role="region"
      aria-label="Prompt queue"
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-foreground hover:cursor-pointer"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="prompt-queue-list"
        >
          <span
            className="inline-block size-1.5 rounded-full bg-amber-500"
            aria-hidden="true"
          />
          <span>
            {hasItems
              ? `Queued: ${items.length}`
              : "Queue while the agent works"}
          </span>
          {hasItems ? (
            <span className="text-muted-foreground/70" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
          ) : null}
        </button>
        <div className="flex items-center gap-1.5">
          {canQueueCurrent ? (
            <button
              type="button"
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-amber-700 hover:cursor-pointer hover:bg-amber-500/15 dark:text-amber-300"
              onClick={onQueueCurrent}
            >
              Queue this
            </button>
          ) : null}
          {hasItems && expanded ? (
            <button
              type="button"
              className="text-muted-foreground hover:cursor-pointer hover:text-foreground"
              onClick={onClear}
            >
              Clear all
            </button>
          ) : null}
        </div>
      </div>
      {expanded && hasItems ? (
        <ul
          id="prompt-queue-list"
          className="mt-2 flex flex-col gap-1.5"
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5"
            >
              <span className="mt-px shrink-0 text-muted-foreground/70 tabular-nums">
                {index + 1}.
              </span>
              <span className="grow whitespace-pre-wrap break-words text-foreground">
                {item.text}
              </span>
              <button
                type="button"
                aria-label="Remove queued prompt"
                onClick={() => onRemove(item.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:cursor-pointer hover:text-foreground"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
