import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ArrowLeftIcon, KanbanSquareIcon, ChevronRightIcon } from "lucide-react";
import {
  KANBAN_COLUMNS,
  type KanbanCard,
  type KanbanColumn,
  type ProjectId,
} from "@t3tools/contracts";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";

/**
 * Read-only Kanban board page. UI is intentionally view-only — every
 * mutation (create / edit / move / schedule / delete) flows through
 * Claude in a thread. See the "How to change anything" hint at the
 * bottom of the page.
 *
 * Top-level navigation: Today view (default) ↔ Full board (4 columns).
 * Project selector at the top — persists the last choice in localStorage
 * so deep-linking from the sidebar lands on the user's last board.
 */

const STORAGE_KEY = "t3.board.lastProjectId";

interface BoardPageProps {
  /** When provided, lets the page render without needing the projects query. */
  readonly projects?: ReadonlyArray<{ id: ProjectId; name: string }>;
}

export function BoardPage({ projects }: BoardPageProps) {
  const [view, setView] = useState<"today" | "full">("today");
  const [selectedProjectId, setSelectedProjectIdRaw] = useState<ProjectId | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return (window.localStorage.getItem(STORAGE_KEY) as ProjectId | null) ?? null;
    } catch {
      return null;
    }
  });
  const setSelectedProjectId = (id: ProjectId | null) => {
    setSelectedProjectIdRaw(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // Resolve a sensible default project — first in the list — when none chosen.
  const projectsList = projects ?? [];
  const effectiveProjectId = selectedProjectId ?? projectsList[0]?.id ?? null;

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-x-hidden bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to="/"
            aria-label="Back to threads"
            className="-ml-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:cursor-pointer hover:bg-muted hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
            <span className="hidden text-xs sm:inline">Threads</span>
          </Link>
          <KanbanSquareIcon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-semibold">Board</h1>
        </div>
        <div className="flex items-center gap-2">
          {projectsList.length > 1 ? (
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={effectiveProjectId ?? ""}
              onChange={(event) =>
                setSelectedProjectId((event.target.value || null) as ProjectId | null)
              }
              aria-label="Pick project"
            >
              {projectsList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="flex overflow-hidden rounded-full border border-border text-xs">
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 hover:cursor-pointer",
                view === "today" ? "bg-primary text-primary-foreground" : "bg-background",
              )}
              onClick={() => setView("today")}
            >
              Today
            </button>
            <button
              type="button"
              className={cn(
                "px-2.5 py-1 hover:cursor-pointer",
                view === "full" ? "bg-primary text-primary-foreground" : "bg-background",
              )}
              onClick={() => setView("full")}
            >
              Full
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        {effectiveProjectId === null ? (
          <EmptyState
            title="No project selected"
            body="Open a thread first; cards live per project."
          />
        ) : view === "today" ? (
          <TodayView projectId={effectiveProjectId} />
        ) : (
          <FullBoardView projectId={effectiveProjectId} />
        )}
      </main>
      <ChatHint />
    </div>
  );
}

// -------------------------------------------------------------------------
// Today view — single vertical list, grouped by relevance
// -------------------------------------------------------------------------

function TodayView({ projectId }: { projectId: ProjectId }) {
  const navigate = useNavigate();
  const cardsQuery = useBoardCards(projectId);
  const groups = useMemo(() => groupForToday(cardsQuery.data ?? []), [cardsQuery.data]);

  if (cardsQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (cardsQuery.isError) {
    return (
      <p className="p-4 text-sm text-rose-600 dark:text-rose-300">
        Couldn’t load the board. {(cardsQuery.error as Error)?.message ?? "Try again."}
      </p>
    );
  }
  if (!groups || groups.totalCards === 0) {
    return (
      <EmptyState
        title="No cards yet"
        body="Ask Claude in any thread to add cards. The board is read-only — every change goes through chat."
      />
    );
  }

  return (
    <div className="flex flex-col">
      <Section title="In Progress" tint="green" cards={groups.inProgress}>
        {groups.inProgress.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            onTap={() =>
              navigate({ to: "/board/card/$cardId", params: { cardId: card.id } })
            }
          />
        ))}
      </Section>
      <Section title="Needs review" tint="amber" cards={groups.needsReview}>
        {groups.needsReview.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            onTap={() =>
              navigate({ to: "/board/card/$cardId", params: { cardId: card.id } })
            }
          />
        ))}
      </Section>
      <Section title="Scheduled today" tint="violet" cards={groups.scheduledToday}>
        {groups.scheduledToday.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            onTap={() =>
              navigate({ to: "/board/card/$cardId", params: { cardId: card.id } })
            }
          />
        ))}
      </Section>
      <Section
        title={`Ready (${groups.ready.length})`}
        tint="blue"
        cards={groups.ready}
      >
        {groups.ready.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            onTap={() =>
              navigate({ to: "/board/card/$cardId", params: { cardId: card.id } })
            }
          />
        ))}
      </Section>
      <Section
        title="Recently done"
        tint="muted"
        cards={groups.recentlyDone}
      >
        {groups.recentlyDone.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            onTap={() =>
              navigate({ to: "/board/card/$cardId", params: { cardId: card.id } })
            }
          />
        ))}
      </Section>
    </div>
  );
}

// -------------------------------------------------------------------------
// Full board — 4 columns, horizontal scroll/snap on mobile
// -------------------------------------------------------------------------

function FullBoardView({ projectId }: { projectId: ProjectId }) {
  const navigate = useNavigate();
  const cardsQuery = useBoardCards(projectId);

  if (cardsQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (cardsQuery.isError) {
    return (
      <p className="p-4 text-sm text-rose-600 dark:text-rose-300">
        Couldn’t load the board.
      </p>
    );
  }
  const cardsByColumn = groupByColumn(cardsQuery.data ?? []);

  // Responsive layout — pure flex, no grid:
  //  - Mobile / iPad portrait: vertical stack (`flex-col`). Each column
  //    section is full-width; cards inside flow naturally.
  //  - lg+ desktop (`flex-row`): four columns side by side, each takes
  //    1/4 width via flex-1; each column has its own internal scroll so
  //    a long Done column doesn't push the page.
  return (
    <div className="flex h-full flex-col gap-2 p-2 sm:gap-3 sm:p-3 lg:flex-row">
      {KANBAN_COLUMNS.map((column) => (
        <section
          key={column}
          className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-card lg:max-h-full lg:flex-1"
        >
          <header className="shrink-0 border-b border-border bg-background/95 px-3 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {labelFor(column)}
              <span className="ml-1 text-muted-foreground/60">
                ({cardsByColumn[column].length})
              </span>
            </h2>
          </header>
          <div className="flex flex-col gap-1.5 p-2 lg:min-h-0 lg:overflow-y-auto">
            {cardsByColumn[column].length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground/70">No cards.</p>
            ) : (
              cardsByColumn[column].map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  onTap={() =>
                    navigate({
                      to: "/board/card/$cardId",
                      params: { cardId: card.id },
                    })
                  }
                />
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------
// Card row (used by both views)
// -------------------------------------------------------------------------

interface CardRowProps {
  readonly card: KanbanCard;
  readonly onTap: () => void;
}

function CardRow({ card, onTap }: CardRowProps) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="group flex w-full items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-left text-sm hover:cursor-pointer hover:border-border/80 hover:bg-card/80"
    >
      <PriorityDot priority={card.priority} />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="truncate font-medium text-foreground">{card.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{labelFor(card.column)}</span>
          {card.needsReview ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
              needs review
            </span>
          ) : null}
          {card.schedule ? (
            <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-violet-700 dark:text-violet-300">
              ⏰ scheduled
            </span>
          ) : null}
          {card.threadId ? <span>· thread bound</span> : null}
        </div>
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function PriorityDot({ priority }: { priority: KanbanCard["priority"] }) {
  const color =
    priority === "urgent"
      ? "bg-rose-500"
      : priority === "high"
        ? "bg-amber-500"
        : priority === "low"
          ? "bg-muted-foreground/40"
          : "bg-emerald-500";
  return (
    <span
      className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", color)}
      aria-hidden="true"
    />
  );
}

// -------------------------------------------------------------------------
// Section header
// -------------------------------------------------------------------------

function Section({
  title,
  tint,
  cards,
  children,
}: {
  title: string;
  tint: "green" | "amber" | "violet" | "blue" | "muted";
  cards: ReadonlyArray<KanbanCard>;
  children: React.ReactNode;
}) {
  if (cards.length === 0) return null;
  const dotColor =
    tint === "green"
      ? "bg-emerald-500"
      : tint === "amber"
        ? "bg-amber-500"
        : tint === "violet"
          ? "bg-violet-500"
          : tint === "muted"
            ? "bg-muted-foreground/40"
            : "bg-sky-500";
  return (
    <section className="border-b border-border last:border-b-0">
      <header className="flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={cn("inline-block size-1.5 rounded-full", dotColor)} aria-hidden="true" />
        {title}
        <span className="text-muted-foreground/60">({cards.length})</span>
      </header>
      <div className="flex flex-col gap-1.5 px-3 pb-3">{children}</div>
    </section>
  );
}

// -------------------------------------------------------------------------
// Hint footer
// -------------------------------------------------------------------------

function ChatHint() {
  return (
    <footer className="border-t border-border bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
      To add, move, schedule, or remove a card, ask Claude in any thread.{" "}
      <Link to="/" className="underline hover:cursor-pointer hover:text-foreground">
        Open a thread →
      </Link>
    </footer>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <KanbanSquareIcon className="size-8 text-muted-foreground/40" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

// -------------------------------------------------------------------------
// Data hook + grouping logic
// -------------------------------------------------------------------------

function useBoardCards(projectId: ProjectId) {
  const localApi = readLocalApi();
  return useQuery({
    queryKey: ["kanban", "list", projectId],
    queryFn: async () => {
      if (!localApi) throw new Error("Local backend unavailable");
      return localApi.kanban.listByProject(projectId);
    },
    refetchInterval: 15_000,
  });
}

interface TodayGroups {
  readonly inProgress: ReadonlyArray<KanbanCard>;
  readonly needsReview: ReadonlyArray<KanbanCard>;
  readonly scheduledToday: ReadonlyArray<KanbanCard>;
  readonly ready: ReadonlyArray<KanbanCard>;
  readonly recentlyDone: ReadonlyArray<KanbanCard>;
  readonly totalCards: number;
}

function groupForToday(cards: ReadonlyArray<KanbanCard>): TodayGroups {
  const now = Date.now();
  // 24h window so a card you mark done in the morning is still on
  // Today by evening — covers the "vanished after Mark Done" surprise.
  const oneDayAgoMs = now - 24 * 3_600_000;
  const inProgress = cards.filter((c) => c.column === "in_progress");
  // "Needs review" = Done cards still flagged for review, OR In-Progress
  // cards that the agent has flagged for human eyes.
  const needsReview = cards.filter((c) => c.needsReview && c.column !== "in_progress");
  const ready = cards.filter((c) => c.column === "ready");
  // Cards with any schedule attached — we don't try to interpret "today"
  // strictly in v1; the chip just signals "there's an automation on this."
  const scheduledToday = cards.filter((c) => c.schedule !== null);
  // Done within the last 24h, sorted most-recent first. Filters out
  // needsReview-Done cards so they don't appear in both groups.
  const recentlyDone = cards
    .filter(
      (c) =>
        c.column === "done" &&
        !c.needsReview &&
        c.doneAt !== null &&
        c.doneAt >= oneDayAgoMs,
    )
    .slice()
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  return {
    inProgress,
    needsReview,
    scheduledToday,
    ready,
    recentlyDone,
    totalCards: cards.length,
  };
}

function groupByColumn(
  cards: ReadonlyArray<KanbanCard>,
): Record<KanbanColumn, ReadonlyArray<KanbanCard>> {
  const result: Record<KanbanColumn, KanbanCard[]> = {
    backlog: [],
    ready: [],
    in_progress: [],
    done: [],
  };
  for (const card of cards) {
    result[card.column].push(card);
  }
  return result;
}

function labelFor(column: KanbanColumn): string {
  switch (column) {
    case "backlog":
      return "Backlog";
    case "ready":
      return "Ready";
    case "in_progress":
      return "In Progress";
    case "done":
      return "Done";
  }
}
