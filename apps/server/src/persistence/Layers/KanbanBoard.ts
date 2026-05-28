import {
  AutomationId,
  AutomationSchedule,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type KanbanRepositoryError,
} from "../Errors.ts";
import {
  DeleteKanbanCardInput,
  GetCardByThreadInput,
  GetKanbanCardInput,
  InsertKanbanArtifactInput,
  InsertKanbanCardInput,
  InsertKanbanNoteInput,
  KanbanRepository,
  type KanbanRepositoryShape,
  ListArtifactsByCardInput,
  ListKanbanCardsByProjectInput,
  ListNotesByCardInput,
  UpdateKanbanCardFieldsInput,
} from "../Services/KanbanBoard.ts";

// -------------------------------------------------------------------------
// Row schemas
// -------------------------------------------------------------------------

const BlockedByJson = Schema.fromJsonString(Schema.Array(KanbanCardId));
const ScheduleFromJson = Schema.fromJsonString(AutomationSchedule);

const KanbanCardDbRow = Schema.Struct({
  id: KanbanCardId,
  projectId: ProjectId,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  column: KanbanColumn,
  priority: KanbanPriority,
  needsReview: Schema.Number,
  threadId: Schema.NullOr(ThreadId),
  lastThreadId: Schema.NullOr(ThreadId),
  schedule: Schema.NullOr(ScheduleFromJson),
  scheduleAutomationId: Schema.NullOr(AutomationId),
  blockedBy: Schema.NullOr(BlockedByJson),
  sortOrder: Schema.Number,
  tasksMirrorId: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
  doneAtMs: Schema.NullOr(Schema.Number),
});

const KanbanArtifactDbRow = Schema.Struct({
  id: KanbanArtifactId,
  cardId: KanbanCardId,
  kind: KanbanArtifactKind,
  payload: Schema.String,
  createdAtMs: Schema.Number,
});

const KanbanNoteDbRow = Schema.Struct({
  id: KanbanNoteId,
  cardId: KanbanCardId,
  text: Schema.String,
  author: Schema.Literals(["agent", "system", "user"]),
  createdAtMs: Schema.Number,
});

function rowToCard(row: typeof KanbanCardDbRow.Type): KanbanCard {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title as KanbanCard["title"],
    description: row.description,
    column: row.column,
    priority: row.priority,
    needsReview: row.needsReview !== 0,
    threadId: row.threadId,
    lastThreadId: row.lastThreadId,
    schedule: row.schedule,
    scheduleAutomationId: row.scheduleAutomationId,
    blockedBy: row.blockedBy,
    sortOrder: row.sortOrder,
    tasksMirrorId: row.tasksMirrorId,
    createdAt: row.createdAtMs,
    updatedAt: row.updatedAtMs,
    doneAt: row.doneAtMs,
  };
}

function rowToArtifact(row: typeof KanbanArtifactDbRow.Type): KanbanArtifact {
  return {
    id: row.id,
    cardId: row.cardId,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.createdAtMs,
  };
}

function rowToNote(row: typeof KanbanNoteDbRow.Type): KanbanNote {
  return {
    id: row.id,
    cardId: row.cardId,
    text: row.text,
    author: row.author,
    createdAt: row.createdAtMs,
  };
}

function toKanbanError(sqlOp: string, decodeOp: string) {
  return (cause: unknown): KanbanRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOp)(cause)
      : toPersistenceSqlError(sqlOp)(cause);
}

const CARD_COLUMNS = `
  id AS "id",
  project_id AS "projectId",
  title AS "title",
  description AS "description",
  column_name AS "column",
  priority AS "priority",
  needs_review AS "needsReview",
  thread_id AS "threadId",
  last_thread_id AS "lastThreadId",
  schedule_json AS "schedule",
  schedule_automation_id AS "scheduleAutomationId",
  blocked_by_json AS "blockedBy",
  sort_order AS "sortOrder",
  tasks_mirror_id AS "tasksMirrorId",
  created_at_ms AS "createdAtMs",
  updated_at_ms AS "updatedAtMs",
  done_at_ms AS "doneAtMs"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ----- card reads --------------------------------------------------------

  const getByIdQuery = SqlSchema.findOneOption({
    Request: GetKanbanCardInput,
    Result: KanbanCardDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          title AS "title",
          description AS "description",
          column_name AS "column",
          priority AS "priority",
          needs_review AS "needsReview",
          thread_id AS "threadId",
          last_thread_id AS "lastThreadId",
          schedule_json AS "schedule",
          schedule_automation_id AS "scheduleAutomationId",
          blocked_by_json AS "blockedBy",
          sort_order AS "sortOrder",
          tasks_mirror_id AS "tasksMirrorId",
          created_at_ms AS "createdAtMs",
          updated_at_ms AS "updatedAtMs",
          done_at_ms AS "doneAtMs"
        FROM kanban_cards
        WHERE id = ${id}
      `,
  });

  const getByThreadQuery = SqlSchema.findOneOption({
    Request: GetCardByThreadInput,
    Result: KanbanCardDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          title AS "title",
          description AS "description",
          column_name AS "column",
          priority AS "priority",
          needs_review AS "needsReview",
          thread_id AS "threadId",
          last_thread_id AS "lastThreadId",
          schedule_json AS "schedule",
          schedule_automation_id AS "scheduleAutomationId",
          blocked_by_json AS "blockedBy",
          sort_order AS "sortOrder",
          tasks_mirror_id AS "tasksMirrorId",
          created_at_ms AS "createdAtMs",
          updated_at_ms AS "updatedAtMs",
          done_at_ms AS "doneAtMs"
        FROM kanban_cards
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const listAllByProjectQuery = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: KanbanCardDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          title AS "title",
          description AS "description",
          column_name AS "column",
          priority AS "priority",
          needs_review AS "needsReview",
          thread_id AS "threadId",
          last_thread_id AS "lastThreadId",
          schedule_json AS "schedule",
          schedule_automation_id AS "scheduleAutomationId",
          blocked_by_json AS "blockedBy",
          sort_order AS "sortOrder",
          tasks_mirror_id AS "tasksMirrorId",
          created_at_ms AS "createdAtMs",
          updated_at_ms AS "updatedAtMs",
          done_at_ms AS "doneAtMs"
        FROM kanban_cards
        WHERE project_id = ${projectId}
        ORDER BY column_name ASC, sort_order ASC, created_at_ms ASC
      `,
  });

  const listByProjectAndColumnQuery = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, column: KanbanColumn }),
    Result: KanbanCardDbRow,
    execute: ({ projectId, column }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          title AS "title",
          description AS "description",
          column_name AS "column",
          priority AS "priority",
          needs_review AS "needsReview",
          thread_id AS "threadId",
          last_thread_id AS "lastThreadId",
          schedule_json AS "schedule",
          schedule_automation_id AS "scheduleAutomationId",
          blocked_by_json AS "blockedBy",
          sort_order AS "sortOrder",
          tasks_mirror_id AS "tasksMirrorId",
          created_at_ms AS "createdAtMs",
          updated_at_ms AS "updatedAtMs",
          done_at_ms AS "doneAtMs"
        FROM kanban_cards
        WHERE project_id = ${projectId} AND column_name = ${column}
        ORDER BY sort_order ASC, created_at_ms ASC
      `,
  });

  // ----- card writes -------------------------------------------------------

  const insertCardQuery = SqlSchema.void({
    Request: InsertKanbanCardInput,
    execute: (input) =>
      sql`
        INSERT INTO kanban_cards (
          id, project_id, title, description, column_name, priority,
          needs_review, thread_id, last_thread_id,
          schedule_json, schedule_automation_id,
          blocked_by_json, sort_order, tasks_mirror_id,
          created_at_ms, updated_at_ms, done_at_ms
        ) VALUES (
          ${input.id}, ${input.projectId}, ${input.title}, ${input.description},
          ${input.column}, ${input.priority},
          0, NULL, NULL,
          NULL, NULL,
          NULL, ${input.sortOrder}, ${input.tasksMirrorId},
          ${input.createdAtMs}, ${input.createdAtMs}, NULL
        )
      `,
  });

  const deleteCardQuery = SqlSchema.findAll({
    Request: DeleteKanbanCardInput,
    Result: Schema.Struct({ id: KanbanCardId }),
    execute: ({ id }) =>
      sql`
        DELETE FROM kanban_cards
        WHERE id = ${id}
        RETURNING id AS "id"
      `,
  });

  // Per-field update — same pattern as the automations repo. One tagged
  // template per supplied field, keeping every statement static.
  const updateCardImpl = (input: UpdateKanbanCardFieldsInput) =>
    Effect.gen(function* () {
      if (input.title !== undefined) {
        yield* sql`UPDATE kanban_cards SET title = ${input.title} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:title")),
        );
      }
      if (input.description !== undefined) {
        yield* sql`UPDATE kanban_cards SET description = ${input.description} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:description")),
        );
      }
      if (input.column !== undefined) {
        yield* sql`UPDATE kanban_cards SET column_name = ${input.column} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:column")),
        );
      }
      if (input.priority !== undefined) {
        yield* sql`UPDATE kanban_cards SET priority = ${input.priority} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:priority")),
        );
      }
      if (input.needsReview !== undefined) {
        const flag = input.needsReview ? 1 : 0;
        yield* sql`UPDATE kanban_cards SET needs_review = ${flag} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:needsReview")),
        );
      }
      if (input.threadId !== undefined) {
        yield* sql`UPDATE kanban_cards SET thread_id = ${input.threadId} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:threadId")),
        );
      }
      if (input.lastThreadId !== undefined) {
        yield* sql`UPDATE kanban_cards SET last_thread_id = ${input.lastThreadId} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:lastThreadId")),
        );
      }
      if (input.scheduleJson !== undefined) {
        yield* sql`UPDATE kanban_cards SET schedule_json = ${input.scheduleJson} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:schedule")),
        );
      }
      if (input.scheduleAutomationId !== undefined) {
        yield* sql`UPDATE kanban_cards SET schedule_automation_id = ${input.scheduleAutomationId} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:scheduleAutomationId")),
        );
      }
      if (input.blockedByJson !== undefined) {
        yield* sql`UPDATE kanban_cards SET blocked_by_json = ${input.blockedByJson} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:blockedBy")),
        );
      }
      if (input.sortOrder !== undefined) {
        yield* sql`UPDATE kanban_cards SET sort_order = ${input.sortOrder} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:sortOrder")),
        );
      }
      if (input.tasksMirrorId !== undefined) {
        yield* sql`UPDATE kanban_cards SET tasks_mirror_id = ${input.tasksMirrorId} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:tasksMirrorId")),
        );
      }
      if (input.doneAtMs !== undefined) {
        yield* sql`UPDATE kanban_cards SET done_at_ms = ${input.doneAtMs} WHERE id = ${input.id}`.pipe(
          Effect.mapError(toPersistenceSqlError("KanbanRepository.update:doneAt")),
        );
      }
      // Bump updated_at_ms last so it captures the change even if only one
      // sub-field moved.
      yield* sql`UPDATE kanban_cards SET updated_at_ms = ${input.updatedAtMs} WHERE id = ${input.id}`.pipe(
        Effect.mapError(toPersistenceSqlError("KanbanRepository.update:updatedAt")),
      );
    });

  // ----- artifacts ---------------------------------------------------------

  const insertArtifactQuery = SqlSchema.void({
    Request: InsertKanbanArtifactInput,
    execute: ({ id, cardId, kind, payload, createdAtMs }) =>
      sql`
        INSERT INTO kanban_card_artifacts (id, card_id, kind, payload, created_at_ms)
        VALUES (${id}, ${cardId}, ${kind}, ${payload}, ${createdAtMs})
      `,
  });

  const listArtifactsQuery = SqlSchema.findAll({
    Request: ListArtifactsByCardInput,
    Result: KanbanArtifactDbRow,
    execute: ({ cardId, limit }) =>
      sql`
        SELECT
          id AS "id",
          card_id AS "cardId",
          kind AS "kind",
          payload AS "payload",
          created_at_ms AS "createdAtMs"
        FROM kanban_card_artifacts
        WHERE card_id = ${cardId}
        ORDER BY created_at_ms DESC, id ASC
        LIMIT ${limit}
      `,
  });

  // ----- notes -------------------------------------------------------------

  const insertNoteQuery = SqlSchema.void({
    Request: InsertKanbanNoteInput,
    execute: ({ id, cardId, text, author, createdAtMs }) =>
      sql`
        INSERT INTO kanban_card_notes (id, card_id, text, author, created_at_ms)
        VALUES (${id}, ${cardId}, ${text}, ${author}, ${createdAtMs})
      `,
  });

  const listNotesQuery = SqlSchema.findAll({
    Request: ListNotesByCardInput,
    Result: KanbanNoteDbRow,
    execute: ({ cardId, limit }) =>
      sql`
        SELECT
          id AS "id",
          card_id AS "cardId",
          text AS "text",
          author AS "author",
          created_at_ms AS "createdAtMs"
        FROM kanban_card_notes
        WHERE card_id = ${cardId}
        ORDER BY created_at_ms DESC, id ASC
        LIMIT ${limit}
      `,
  });

  // ----- public shape ------------------------------------------------------

  const insertCard: KanbanRepositoryShape["insertCard"] = (input) =>
    insertCardQuery(input).pipe(
      Effect.mapError(
        toKanbanError("KanbanRepository.insertCard:query", "KanbanRepository.insertCard:encode"),
      ),
    );

  const updateCard: KanbanRepositoryShape["updateCard"] = (input) => updateCardImpl(input);

  const deleteCard: KanbanRepositoryShape["deleteCard"] = (input) =>
    deleteCardQuery(input).pipe(
      Effect.mapError(
        toKanbanError("KanbanRepository.deleteCard:query", "KanbanRepository.deleteCard:decode"),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getCard: KanbanRepositoryShape["getCard"] = (input) =>
    getByIdQuery(input).pipe(
      Effect.mapError(
        toKanbanError("KanbanRepository.getCard:query", "KanbanRepository.getCard:decode"),
      ),
      Effect.map((row) =>
        Option.match(row, {
          onNone: () => Option.none<KanbanCard>(),
          onSome: (r) => Option.some(rowToCard(r)),
        }),
      ),
    );

  const listByProject: KanbanRepositoryShape["listByProject"] = (input) =>
    input.column !== undefined
      ? listByProjectAndColumnQuery({
          projectId: input.projectId,
          column: input.column,
        }).pipe(
          Effect.mapError(
            toKanbanError(
              "KanbanRepository.listByProject:column:query",
              "KanbanRepository.listByProject:column:decode",
            ),
          ),
          Effect.map((rows) => rows.map(rowToCard)),
        )
      : listAllByProjectQuery({ projectId: input.projectId }).pipe(
          Effect.mapError(
            toKanbanError(
              "KanbanRepository.listByProject:all:query",
              "KanbanRepository.listByProject:all:decode",
            ),
          ),
          Effect.map((rows) => rows.map(rowToCard)),
        );

  const getCardByThread: KanbanRepositoryShape["getCardByThread"] = (input) =>
    getByThreadQuery(input).pipe(
      Effect.mapError(
        toKanbanError(
          "KanbanRepository.getCardByThread:query",
          "KanbanRepository.getCardByThread:decode",
        ),
      ),
      Effect.map((row) =>
        Option.match(row, {
          onNone: () => Option.none<KanbanCard>(),
          onSome: (r) => Option.some(rowToCard(r)),
        }),
      ),
    );

  const insertArtifact: KanbanRepositoryShape["insertArtifact"] = (input) =>
    insertArtifactQuery(input).pipe(
      Effect.mapError(
        toKanbanError(
          "KanbanRepository.insertArtifact:query",
          "KanbanRepository.insertArtifact:encode",
        ),
      ),
    );

  const listArtifactsByCard: KanbanRepositoryShape["listArtifactsByCard"] = (input) =>
    listArtifactsQuery(input).pipe(
      Effect.mapError(
        toKanbanError(
          "KanbanRepository.listArtifactsByCard:query",
          "KanbanRepository.listArtifactsByCard:decode",
        ),
      ),
      Effect.map((rows) => rows.map(rowToArtifact)),
    );

  const insertNote: KanbanRepositoryShape["insertNote"] = (input) =>
    insertNoteQuery(input).pipe(
      Effect.mapError(
        toKanbanError("KanbanRepository.insertNote:query", "KanbanRepository.insertNote:encode"),
      ),
    );

  const listNotesByCard: KanbanRepositoryShape["listNotesByCard"] = (input) =>
    listNotesQuery(input).pipe(
      Effect.mapError(
        toKanbanError(
          "KanbanRepository.listNotesByCard:query",
          "KanbanRepository.listNotesByCard:decode",
        ),
      ),
      Effect.map((rows) => rows.map(rowToNote)),
    );

  return {
    insertCard,
    updateCard,
    deleteCard,
    getCard,
    listByProject,
    getCardByThread,
    insertArtifact,
    listArtifactsByCard,
    insertNote,
    listNotesByCard,
  } satisfies KanbanRepositoryShape;
});

export const KanbanRepositoryLive = Layer.effect(KanbanRepository, make);

// Reference CARD_COLUMNS so the constant isn't tree-shaken into a lint error;
// the queries embed it via tagged-template literal expansion.
void CARD_COLUMNS;
