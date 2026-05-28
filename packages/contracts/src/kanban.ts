/**
 * Per-project Kanban board contract.
 *
 * The model: cards live in one of four columns (Backlog / Ready /
 * In Progress / Done). The UI is **read-only** — every create / edit /
 * move / schedule / delete happens through Claude's Agent SDK tools
 * (see `apps/server/src/kanban/tools/*`). Server-side state is the
 * source of truth; client just renders.
 *
 * Mirroring: each card has a `tasksMirrorId` linking to a Claude Code
 * Tasks API entry under the project's `CLAUDE_CODE_TASK_LIST_ID`,
 * so the agent's native TaskCreate calls and the board stay in sync.
 *
 * Scheduling: cards can carry an `AutomationSchedule` (the same shape
 * used by Scheduled Automations). When set, a hidden automations row
 * is created with `action.kind = "run-card"` so the existing
 * AutomationScheduler picks them up — no second scheduler.
 */

import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AutomationId, AutomationSchedule } from "./automation.ts";

// -------------------------------------------------------------------------
// Ids
// -------------------------------------------------------------------------

export const KanbanCardId = Schema.String.pipe(Schema.brand("KanbanCardId"));
export type KanbanCardId = typeof KanbanCardId.Type;

export const KanbanArtifactId = Schema.String.pipe(Schema.brand("KanbanArtifactId"));
export type KanbanArtifactId = typeof KanbanArtifactId.Type;

export const KanbanNoteId = Schema.String.pipe(Schema.brand("KanbanNoteId"));
export type KanbanNoteId = typeof KanbanNoteId.Type;

// -------------------------------------------------------------------------
// Columns + priority
// -------------------------------------------------------------------------

export const KanbanColumn = Schema.Literals(["backlog", "ready", "in_progress", "done"]);
export type KanbanColumn = typeof KanbanColumn.Type;
export const DEFAULT_KANBAN_COLUMN: KanbanColumn = "backlog";

export const KANBAN_COLUMNS: ReadonlyArray<KanbanColumn> = [
  "backlog",
  "ready",
  "in_progress",
  "done",
] as const;

export const KanbanPriority = Schema.Literals(["low", "normal", "high", "urgent"]);
export type KanbanPriority = typeof KanbanPriority.Type;
export const DEFAULT_KANBAN_PRIORITY: KanbanPriority = "normal";

// -------------------------------------------------------------------------
// Artifacts (attached by the agent on each run)
// -------------------------------------------------------------------------

export const KanbanArtifactKind = Schema.Literals([
  "diff",
  "screenshot",
  "log",
  "pr",
  "commit",
  "note",
]);
export type KanbanArtifactKind = typeof KanbanArtifactKind.Type;

export const KanbanArtifact = Schema.Struct({
  id: KanbanArtifactId,
  cardId: KanbanCardId,
  kind: KanbanArtifactKind,
  /** Free-form JSON payload — shape depends on `kind`. */
  payload: Schema.String,
  createdAt: Schema.Number,
});
export type KanbanArtifact = typeof KanbanArtifact.Type;

// -------------------------------------------------------------------------
// Journal notes (free-form text appended over the card's life)
// -------------------------------------------------------------------------

export const KanbanNote = Schema.Struct({
  id: KanbanNoteId,
  cardId: KanbanCardId,
  text: Schema.String,
  /** "agent" if added by Claude via the tool, "system" for automatic
   *  entries (column moves, schedule changes), "user" reserved for v2. */
  author: Schema.Literals(["agent", "system", "user"]),
  createdAt: Schema.Number,
});
export type KanbanNote = typeof KanbanNote.Type;

// -------------------------------------------------------------------------
// Card record
// -------------------------------------------------------------------------

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  column: KanbanColumn,
  priority: KanbanPriority,
  /** Set to true when an agent run finishes; clears when the card moves. */
  needsReview: Schema.Boolean,
  /** Currently bound thread (one card at a time runs in one thread). */
  threadId: Schema.NullOr(ThreadId),
  /** Most recent thread that worked the card. Same as threadId until a new run. */
  lastThreadId: Schema.NullOr(ThreadId),
  /** Schedule + linked automations row, if scheduled. */
  schedule: Schema.NullOr(AutomationSchedule),
  scheduleAutomationId: Schema.NullOr(AutomationId),
  /** Comma-separated card ids the card is blocked on. Null = unblocked. */
  blockedBy: Schema.NullOr(Schema.Array(KanbanCardId)),
  /** Fractional index for sort order (low = top). */
  sortOrder: Schema.Number,
  /** Mirror to the project's `CLAUDE_CODE_TASK_LIST_ID` task entry. */
  tasksMirrorId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  doneAt: Schema.NullOr(Schema.Number),
});
export type KanbanCard = typeof KanbanCard.Type;

/** Detailed card with attached artifacts + recent notes, used by detail screen. */
export const KanbanCardDetail = Schema.Struct({
  card: KanbanCard,
  artifacts: Schema.Array(KanbanArtifact),
  notes: Schema.Array(KanbanNote),
});
export type KanbanCardDetail = typeof KanbanCardDetail.Type;

// -------------------------------------------------------------------------
// Tool / RPC inputs
// -------------------------------------------------------------------------

export const CreateKanbanCardInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  column: Schema.optionalKey(KanbanColumn),
  priority: Schema.optionalKey(KanbanPriority),
  /**
   * Thread id to bind to the card at creation time. When Claude calls
   * this endpoint from inside a thread, it MUST include its current
   * threadId here so Run Now and scheduled runs have somewhere to
   * dispatch to without an extra manual bind step. Optional only for
   * backward-compat / out-of-thread test scenarios.
   */
  threadId: Schema.optionalKey(ThreadId),
});
export type CreateKanbanCardInput = typeof CreateKanbanCardInput.Type;

export const UpdateKanbanCardInput = Schema.Struct({
  id: KanbanCardId,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priority: Schema.optionalKey(KanbanPriority),
  needsReview: Schema.optionalKey(Schema.Boolean),
});
export type UpdateKanbanCardInput = typeof UpdateKanbanCardInput.Type;

export const MoveKanbanCardInput = Schema.Struct({
  id: KanbanCardId,
  column: KanbanColumn,
  note: Schema.optionalKey(Schema.String),
});
export type MoveKanbanCardInput = typeof MoveKanbanCardInput.Type;

export const ScheduleKanbanCardInput = Schema.Struct({
  id: KanbanCardId,
  schedule: AutomationSchedule,
});
export type ScheduleKanbanCardInput = typeof ScheduleKanbanCardInput.Type;

export const AttachKanbanArtifactInput = Schema.Struct({
  cardId: KanbanCardId,
  kind: KanbanArtifactKind,
  payload: Schema.String,
});
export type AttachKanbanArtifactInput = typeof AttachKanbanArtifactInput.Type;

export const AddKanbanNoteInput = Schema.Struct({
  cardId: KanbanCardId,
  text: TrimmedNonEmptyString,
});
export type AddKanbanNoteInput = typeof AddKanbanNoteInput.Type;

// -------------------------------------------------------------------------
// Filters for list reads
// -------------------------------------------------------------------------

export const KanbanListFilter = Schema.Struct({
  projectId: ProjectId,
  column: Schema.optionalKey(KanbanColumn),
  includeBlocked: Schema.optionalKey(Schema.Boolean),
});
export type KanbanListFilter = typeof KanbanListFilter.Type;

// -------------------------------------------------------------------------
// Summary for the system-prompt awareness block
// -------------------------------------------------------------------------

export const KanbanBoardSummary = Schema.Struct({
  projectId: ProjectId,
  totals: Schema.Struct({
    backlog: Schema.Number,
    ready: Schema.Number,
    inProgress: Schema.Number,
    done: Schema.Number,
  }),
  /** Up to 5 most-recent active cards (in_progress + needs_review). */
  active: Schema.Array(KanbanCard),
  scheduledTodayCount: Schema.Number,
});
export type KanbanBoardSummary = typeof KanbanBoardSummary.Type;
