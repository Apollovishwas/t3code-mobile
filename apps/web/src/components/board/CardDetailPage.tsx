import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowLeftIcon,
  CheckIcon,
  EyeIcon,
  MessageSquareTextIcon,
  PlayCircleIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type {
  KanbanArtifact,
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanNote,
} from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "~/store";

/**
 * Card detail page.
 *
 * Mutations are now **direct API calls** from the UI — the user can
 * mark done, mark needs-review, add a comment, set a schedule, run the
 * card, or delete it without going through Claude. (The earlier "Claude
 * is the only mutator" rule applied to the board *list* view only — drag
 * and inline-edit there are still disabled; this detail screen is the
 * dedicated management surface for a single card.)
 *
 * Run requires a bound thread. If the card has none, the "Run again"
 * button is disabled with a hint to open a thread for it first.
 */

// Empty base = same origin as the PWA. The server hosts both the PWA
// and the /api/board/* endpoints on the same port, whether you reach
// the PWA via 127.0.0.1, a Tailscale ts.net hostname, or anything else.
const API_BASE = "";

interface CardDetailPageProps {
  readonly cardId: KanbanCardId;
}

export function CardDetailPage({ cardId }: CardDetailPageProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Look up the project's environmentId so we can navigate to the bound
  // thread's URL (`/<envId>/<threadId>`). Cards only carry projectId;
  // the environmentId lives on the Project record in the store.
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  // Reads still go through the existing WS RPC (`localApi.kanban.*`) — it's
  // already on a hot connection and gives us back-pressure for free.
  // Writes go through the localhost HTTP API so we get individual
  // success/failure per action without piping new mutating verbs through
  // the WS layer.
  const cardQuery = useQuery({
    queryKey: ["kanban", "card", cardId],
    queryFn: () => fetchCard(cardId),
    refetchInterval: 15_000,
  });
  const notesQuery = useQuery({
    queryKey: ["kanban", "notes", cardId],
    queryFn: () => fetchNotes(cardId),
  });
  const artifactsQuery = useQuery({
    queryKey: ["kanban", "artifacts", cardId],
    queryFn: () => fetchArtifacts(cardId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["kanban", "card", cardId] });
    qc.invalidateQueries({ queryKey: ["kanban", "notes", cardId] });
    qc.invalidateQueries({ queryKey: ["kanban", "artifacts", cardId] });
    qc.invalidateQueries({ queryKey: ["kanban", "list"] });
  };

  // ---- Mutations -------------------------------------------------------

  const moveMutation = useMutation({
    mutationFn: (column: KanbanColumn) =>
      apiPost(`/api/board/cards/${cardId}/move`, { column }),
    onSuccess: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: (patch: { needsReview?: boolean; priority?: KanbanCard["priority"] }) =>
      apiPatch(`/api/board/cards/${cardId}`, patch),
    onSuccess: invalidate,
  });

  const addNoteMutation = useMutation({
    mutationFn: (text: string) =>
      apiPost(`/api/board/cards/${cardId}/notes`, { text }),
    onSuccess: invalidate,
  });

  const scheduleMutation = useMutation({
    mutationFn: (minutes: number) =>
      apiPost(`/api/board/cards/${cardId}/schedule`, {
        schedule: { kind: "interval", minutes },
      }),
    onSuccess: invalidate,
  });

  const unscheduleMutation = useMutation({
    mutationFn: () => apiDelete(`/api/board/cards/${cardId}/schedule`),
    onSuccess: invalidate,
  });

  const runMutation = useMutation({
    mutationFn: () => apiPost(`/api/board/cards/${cardId}/run`, {}),
    onSuccess: () => {
      invalidate();
      // Take the user straight to the thread — that's where the agent
      // is actually doing the work now, and the card detail page can't
      // show in-flight progress.
      const card = cardQuery.data ?? null;
      if (!card?.threadId) return;
      const envId = projects.find((p) => p.id === card.projectId)?.environmentId;
      if (!envId) return;
      navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: envId, threadId: card.threadId },
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/api/board/cards/${cardId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kanban", "list"] });
      navigate({ to: "/board" });
    },
  });

  // ---- Local UI state ---------------------------------------------------

  const [commentDraft, setCommentDraft] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleMinutes, setScheduleMinutes] = useState(60);

  const card = cardQuery.data ?? null;

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-x-hidden bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
        <button
          type="button"
          aria-label="Back to board"
          className="rounded-md p-1 text-muted-foreground hover:cursor-pointer hover:bg-muted hover:text-foreground"
          onClick={() => navigate({ to: "/board" })}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {card?.title ?? (cardQuery.isLoading ? "Loading…" : "Card not found")}
        </h1>
        <Link
          to="/"
          className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:cursor-pointer hover:bg-muted hover:text-foreground"
        >
          Threads
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-4 sm:px-4">
        {cardQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !card ? (
          <p className="text-sm text-rose-600 dark:text-rose-300">
            That card no longer exists.
          </p>
        ) : (
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            {/* ---- Title + description ----
                `min-w-0` on the flex parent + `overflow-hidden` on the
                section is the magic combo that lets long URLs or
                unbroken token strings break inside the card instead of
                blowing it out horizontally. `overflowWrap: 'anywhere'`
                breaks even mid-token when nothing else fits. */}
            <section className="overflow-hidden rounded-lg border border-border bg-card p-4">
              <h2 className="break-words text-lg font-semibold leading-snug text-foreground">
                {card.title}
              </h2>
              {card.description ? (
                <p
                  className="mt-2 whitespace-pre-wrap text-sm text-foreground/90"
                  style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
                >
                  {card.description}
                </p>
              ) : (
                <p className="mt-2 text-sm italic text-muted-foreground">
                  No description yet.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                <Pill>Column: {labelForColumn(card.column)}</Pill>
                <Pill>Priority: {card.priority}</Pill>
                {card.needsReview ? <Pill tone="amber">Needs review</Pill> : null}
                {card.schedule ? (
                  <Pill tone="violet">⏰ every {card.schedule.minutes} min</Pill>
                ) : null}
                {card.threadId ? <Pill tone="emerald">Thread bound</Pill> : null}
              </div>
            </section>

            {/* ---- Primary CTA (Open thread) ----
                If the card is bound to a real thread, route directly
                to that thread's URL so the user watches the live work.
                If not bound, fall back to home which lands them on the
                most-recent thread. */}
            {(() => {
              const envId = projects.find((p) => p.id === card.projectId)?.environmentId;
              const canNavToBoundThread = card.threadId !== null && envId !== undefined;
              if (canNavToBoundThread) {
                return (
                  <button
                    type="button"
                    onClick={() =>
                      navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId: envId, threadId: card.threadId! },
                      })
                    }
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground hover:cursor-pointer"
                  >
                    <MessageSquareTextIcon className="size-4" />
                    Open thread for this card
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  onClick={() => navigate({ to: "/" })}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-background px-3 py-2.5 text-sm text-foreground hover:cursor-pointer hover:bg-muted"
                >
                  <MessageSquareTextIcon className="size-4" />
                  Open a thread to work on this card
                </button>
              );
            })()}

            {/* ---- Direct actions ---- */}
            <section className="rounded-lg border border-border bg-card p-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Actions
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <ActionButton
                  label="Mark done"
                  icon={<CheckIcon className="size-3.5" />}
                  tone="emerald"
                  disabled={card.column === "done" || moveMutation.isPending}
                  onClick={() => moveMutation.mutate("done")}
                />
                <ActionButton
                  label={card.column === "in_progress" ? "In progress" : "Start"}
                  icon={<PlayCircleIcon className="size-3.5" />}
                  tone="sky"
                  disabled={card.column === "in_progress" || moveMutation.isPending}
                  onClick={() => moveMutation.mutate("in_progress")}
                />
                <ActionButton
                  label="Run now"
                  icon={<PlayCircleIcon className="size-3.5" />}
                  tone="sky"
                  disabled={!card.threadId || runMutation.isPending}
                  {...(!card.threadId ? { hint: "Bind a thread first" } : {})}
                  onClick={() => runMutation.mutate()}
                />
                <ActionButton
                  label={card.needsReview ? "Clear review" : "Needs review"}
                  icon={<EyeIcon className="size-3.5" />}
                  tone="amber"
                  disabled={patchMutation.isPending}
                  onClick={() =>
                    patchMutation.mutate({ needsReview: !card.needsReview })
                  }
                />
                <ActionButton
                  label={
                    card.schedule
                      ? `Edit schedule (${card.schedule.minutes}m)`
                      : "Schedule"
                  }
                  icon={<span className="text-[11px]">⏰</span>}
                  tone="violet"
                  onClick={() => setShowSchedule((v) => !v)}
                />
                <ActionButton
                  label="Delete"
                  icon={<Trash2Icon className="size-3.5" />}
                  tone="rose"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete card "${card.title}"?`)) {
                      deleteMutation.mutate();
                    }
                  }}
                />
              </div>

              {/* Inline schedule form, expands on Schedule tap. */}
              {showSchedule ? (
                <div className="mt-3 flex flex-col gap-2 rounded-md border border-dashed border-border bg-background p-2.5 text-xs">
                  <span className="font-medium">Run every</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[5, 15, 60, 240, 720, 1440].map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs hover:cursor-pointer",
                          scheduleMinutes === minutes
                            ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                            : "border-border bg-background hover:bg-muted",
                        )}
                        onClick={() => setScheduleMinutes(minutes)}
                      >
                        {minutes < 60
                          ? `${minutes}m`
                          : minutes === 60
                            ? "1h"
                            : minutes === 1440
                              ? "24h"
                              : `${minutes / 60}h`}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      className="rounded-full bg-violet-500/90 px-3 py-1.5 text-xs text-white hover:cursor-pointer disabled:opacity-50"
                      disabled={scheduleMutation.isPending}
                      onClick={() => {
                        scheduleMutation.mutate(scheduleMinutes);
                        setShowSchedule(false);
                      }}
                    >
                      {card.schedule ? "Replace schedule" : "Save schedule"}
                    </button>
                    {card.schedule ? (
                      <button
                        type="button"
                        className="rounded-full border border-border bg-background px-3 py-1.5 text-xs hover:cursor-pointer hover:bg-muted"
                        disabled={unscheduleMutation.isPending}
                        onClick={() => {
                          unscheduleMutation.mutate();
                          setShowSchedule(false);
                        }}
                      >
                        Unschedule
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label="Close schedule editor"
                      className="ml-auto rounded-md p-1 text-muted-foreground hover:cursor-pointer hover:bg-muted"
                      onClick={() => setShowSchedule(false)}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                  {!card.threadId ? (
                    <p className="text-[11px] text-amber-600 dark:text-amber-300">
                      Note: scheduled runs land in the bound thread. Open a thread
                      for this card so future fires have somewhere to go.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>

            {/* ---- Add comment ---- */}
            <section className="rounded-lg border border-border bg-card p-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Add a comment
              </h3>
              <textarea
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                placeholder="Quick note for yourself or for Claude to read later…"
                rows={2}
                className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={commentDraft.trim().length === 0 || addNoteMutation.isPending}
                  onClick={() => {
                    const text = commentDraft.trim();
                    if (text.length === 0) return;
                    addNoteMutation.mutate(text);
                    setCommentDraft("");
                  }}
                  className="rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:cursor-pointer disabled:opacity-50"
                >
                  Add comment
                </button>
              </div>
            </section>

            {/* ---- Artifacts ---- */}
            <ArtifactsSection
              isLoading={artifactsQuery.isLoading}
              artifacts={artifactsQuery.data ?? []}
            />

            {/* ---- Activity ---- */}
            <NotesSection isLoading={notesQuery.isLoading} notes={notesQuery.data ?? []} />
          </div>
        )}
      </main>
    </div>
  );
}

// -------------------------------------------------------------------------
// Action button — simple coloured pill with disabled / hint support
// -------------------------------------------------------------------------

interface ActionButtonProps {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly tone: "default" | "emerald" | "sky" | "amber" | "violet" | "rose";
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly onClick: () => void;
}

function ActionButton({ label, icon, tone, disabled, hint, onClick }: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className={cn(
        // `min-w-0` lets the inner `<span class="truncate">` actually
        // clip — without it the label can grow past the grid cell and
        // push the whole row out of the page on narrow screens.
        "flex min-w-0 items-center justify-center gap-1.5 rounded-full border px-3 py-2 text-xs transition-colors hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
        toneClass(tone),
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function toneClass(tone: ActionButtonProps["tone"]): string {
  switch (tone) {
    case "emerald":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15";
    case "violet":
      return "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/15";
    case "sky":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 hover:bg-sky-500/15";
    case "amber":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15";
    case "rose":
      return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/15";
    default:
      return "border-border bg-card text-foreground hover:bg-muted";
  }
}

// -------------------------------------------------------------------------
// Artifacts + notes (no content-visibility — was causing layout jumps)
// -------------------------------------------------------------------------

function ArtifactsSection({
  isLoading,
  artifacts,
}: {
  isLoading: boolean;
  artifacts: ReadonlyArray<KanbanArtifact>;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Artifacts ({artifacts.length})
      </h2>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : artifacts.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          Nothing yet. Claude attaches diffs, screenshots, and PR links here as
          it works the card.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {artifacts.map((artifact) => (
            <li
              key={artifact.id}
              className="overflow-hidden rounded-md border border-border bg-background p-2 text-xs"
            >
              <div className="font-medium text-foreground">{artifact.kind}</div>
              <pre
                className="mt-0.5 whitespace-pre-wrap text-[11px] text-muted-foreground"
                style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
              >
                {artifact.payload}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NotesSection({
  isLoading,
  notes,
}: {
  isLoading: boolean;
  notes: ReadonlyArray<KanbanNote>;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Activity ({notes.length})
      </h2>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {notes.map((note) => (
            <li
              key={note.id}
              className="text-xs"
              style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
            >
              <span className="mr-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {note.author}
              </span>
              <span className="text-foreground">{note.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "amber" | "violet" | "emerald";
}) {
  const cls =
    tone === "amber"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : tone === "violet"
        ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
        : tone === "emerald"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "bg-muted text-muted-foreground";
  return <span className={cn("rounded-full px-2 py-0.5", cls)}>{children}</span>;
}

function labelForColumn(column: string): string {
  switch (column) {
    case "backlog":
      return "Backlog";
    case "ready":
      return "Ready";
    case "in_progress":
      return "In Progress";
    case "done":
      return "Done";
    default:
      return column;
  }
}

// -------------------------------------------------------------------------
// Fetch helpers — bare fetch against the local kanban HTTP API. Using the
// same hostname the PWA was loaded from so Tailscale / localhost / IP
// all work without separate config. Port 3773 matches the server bind.
// -------------------------------------------------------------------------

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status}`);
  return await response.json();
}
async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`PATCH ${path} -> ${response.status}`);
  return await response.json();
}
async function apiDelete(path: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) throw new Error(`DELETE ${path} -> ${response.status}`);
  return await response.json();
}

// The card/notes/artifacts reads still go through the existing RPC; we
// just import them lazily here so the file's data path stays single-API.
import { readLocalApi } from "~/localApi";
async function fetchCard(id: KanbanCardId) {
  const api = readLocalApi();
  if (!api) throw new Error("Local backend unavailable");
  return api.kanban.getCard(id);
}
async function fetchNotes(id: KanbanCardId) {
  const api = readLocalApi();
  if (!api) throw new Error("Local backend unavailable");
  return api.kanban.listNotes(id, 50);
}
async function fetchArtifacts(id: KanbanCardId) {
  const api = readLocalApi();
  if (!api) throw new Error("Local backend unavailable");
  return api.kanban.listArtifacts(id, 50);
}
