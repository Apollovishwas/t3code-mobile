import {
  AutomationId,
  KanbanArtifact,
  KanbanArtifactId,
  KanbanArtifactKind,
  KanbanCard,
  KanbanCardId,
  KanbanColumn,
  KanbanNote,
  KanbanNoteId,
  KanbanPriority,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { KanbanRepositoryError } from "../Errors.ts";

/**
 * Per-project Kanban board persistence. Cards live in the
 * `kanban_cards` table; artifacts + notes are in sibling tables.
 *
 * Reads power the read-only UI. Writes are invoked exclusively by the
 * Agent SDK tool layer (`apps/server/src/kanban/tools/*`) — there are
 * no client-facing RPC verbs that mutate. The user's only mutation
 * path is "ask Claude in any thread."
 */

// -------------------------------------------------------------------------
// Inputs
// -------------------------------------------------------------------------

export const InsertKanbanCardInput = Schema.Struct({
  id: KanbanCardId,
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  column: KanbanColumn,
  priority: KanbanPriority,
  sortOrder: Schema.Number,
  tasksMirrorId: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
});
export type InsertKanbanCardInput = typeof InsertKanbanCardInput.Type;

export const GetKanbanCardInput = Schema.Struct({ id: KanbanCardId });
export type GetKanbanCardInput = typeof GetKanbanCardInput.Type;

export const ListKanbanCardsByProjectInput = Schema.Struct({
  projectId: ProjectId,
  column: Schema.optionalKey(KanbanColumn),
});
export type ListKanbanCardsByProjectInput = typeof ListKanbanCardsByProjectInput.Type;

export const DeleteKanbanCardInput = Schema.Struct({ id: KanbanCardId });
export type DeleteKanbanCardInput = typeof DeleteKanbanCardInput.Type;

export const UpdateKanbanCardFieldsInput = Schema.Struct({
  id: KanbanCardId,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  column: Schema.optionalKey(KanbanColumn),
  priority: Schema.optionalKey(KanbanPriority),
  needsReview: Schema.optionalKey(Schema.Boolean),
  threadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  lastThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  scheduleJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
  scheduleAutomationId: Schema.optionalKey(Schema.NullOr(AutomationId)),
  blockedByJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sortOrder: Schema.optionalKey(Schema.Number),
  tasksMirrorId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  updatedAtMs: Schema.Number,
  doneAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type UpdateKanbanCardFieldsInput = typeof UpdateKanbanCardFieldsInput.Type;

export const InsertKanbanArtifactInput = Schema.Struct({
  id: KanbanArtifactId,
  cardId: KanbanCardId,
  kind: KanbanArtifactKind,
  payload: Schema.String,
  createdAtMs: Schema.Number,
});
export type InsertKanbanArtifactInput = typeof InsertKanbanArtifactInput.Type;

export const ListArtifactsByCardInput = Schema.Struct({
  cardId: KanbanCardId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});
export type ListArtifactsByCardInput = typeof ListArtifactsByCardInput.Type;

export const InsertKanbanNoteInput = Schema.Struct({
  id: KanbanNoteId,
  cardId: KanbanCardId,
  text: Schema.String,
  author: Schema.Literals(["agent", "system", "user"]),
  createdAtMs: Schema.Number,
});
export type InsertKanbanNoteInput = typeof InsertKanbanNoteInput.Type;

export const ListNotesByCardInput = Schema.Struct({
  cardId: KanbanCardId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});
export type ListNotesByCardInput = typeof ListNotesByCardInput.Type;

export const GetCardByThreadInput = Schema.Struct({ threadId: ThreadId });
export type GetCardByThreadInput = typeof GetCardByThreadInput.Type;

// -------------------------------------------------------------------------
// Shape
// -------------------------------------------------------------------------

export interface KanbanRepositoryShape {
  // ----- card lifecycle ---------------------------------------------------
  readonly insertCard: (
    input: InsertKanbanCardInput,
  ) => Effect.Effect<void, KanbanRepositoryError>;
  readonly updateCard: (
    input: UpdateKanbanCardFieldsInput,
  ) => Effect.Effect<void, KanbanRepositoryError>;
  readonly deleteCard: (
    input: DeleteKanbanCardInput,
  ) => Effect.Effect<boolean, KanbanRepositoryError>;
  readonly getCard: (
    input: GetKanbanCardInput,
  ) => Effect.Effect<Option.Option<KanbanCard>, KanbanRepositoryError>;
  readonly listByProject: (
    input: ListKanbanCardsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<KanbanCard>, KanbanRepositoryError>;
  readonly getCardByThread: (
    input: GetCardByThreadInput,
  ) => Effect.Effect<Option.Option<KanbanCard>, KanbanRepositoryError>;

  // ----- artifacts --------------------------------------------------------
  readonly insertArtifact: (
    input: InsertKanbanArtifactInput,
  ) => Effect.Effect<void, KanbanRepositoryError>;
  readonly listArtifactsByCard: (
    input: ListArtifactsByCardInput,
  ) => Effect.Effect<ReadonlyArray<KanbanArtifact>, KanbanRepositoryError>;

  // ----- notes ------------------------------------------------------------
  readonly insertNote: (
    input: InsertKanbanNoteInput,
  ) => Effect.Effect<void, KanbanRepositoryError>;
  readonly listNotesByCard: (
    input: ListNotesByCardInput,
  ) => Effect.Effect<ReadonlyArray<KanbanNote>, KanbanRepositoryError>;
}

export class KanbanRepository extends Context.Service<
  KanbanRepository,
  KanbanRepositoryShape
>()("t3/persistence/Services/KanbanBoard/KanbanRepository") {}
