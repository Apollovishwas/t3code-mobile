import {
  Automation,
  AutomationAction,
  AutomationId,
  AutomationRun,
  AutomationSchedule,
  AutomationStatus,
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
  type AutomationRepositoryError,
} from "../Errors.ts";
import {
  AppendAutomationRunInput,
  AutomationRepository,
  type AutomationRepositoryShape,
  DeleteAutomationInput,
  GetAutomationByIdInput,
  InsertAutomationInput,
  ListAllAutomationsInput,
  ListAutomationsByProjectInput,
  ListDueAutomationsInput,
  ListRecentRunsInput,
  MarkAutomationFailedInput,
  MarkAutomationFiredInput,
  UpdateAutomationFieldsInput,
} from "../Services/Automations.ts";

// -------------------------------------------------------------------------
// Row schemas
//
// JSON columns decode through `Schema.fromJsonString` so reads come out
// already-typed. Writes go in as raw stringified JSON via the SQL template
// — the caller's responsibility, kept narrow in the InsertAutomationInput.
// -------------------------------------------------------------------------

const AutomationDbRow = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  name: Schema.String,
  status: AutomationStatus,
  schedule: Schema.fromJsonString(AutomationSchedule),
  action: Schema.fromJsonString(AutomationAction),
  lastRunAtMs: Schema.NullOr(Schema.Number),
  nextRunAtMs: Schema.NullOr(Schema.Number),
  lastErrorMessage: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
});

const AutomationRunDbRow = Schema.Struct({
  id: Schema.String,
  automationId: AutomationId,
  outcome: Schema.Literals(["fired", "failed", "skipped"]),
  detail: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  ranAtMs: Schema.Number,
});

function rowToAutomation(row: typeof AutomationDbRow.Type): Automation {
  return {
    id: row.id,
    name: row.name as Automation["name"],
    projectId: row.projectId,
    status: row.status,
    schedule: row.schedule,
    action: row.action,
    lastRunAt: row.lastRunAtMs,
    nextRunAt: row.nextRunAtMs,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAtMs,
  };
}

function rowToRun(row: typeof AutomationRunDbRow.Type): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    outcome: row.outcome,
    detail: row.detail,
    threadId: row.threadId,
    ranAt: row.ranAtMs,
  };
}

function toAutomationError(sqlOp: string, decodeOp: string) {
  return (cause: unknown): AutomationRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOp)(cause)
      : toPersistenceSqlError(sqlOp)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ----- Reads -------------------------------------------------------------

  const listByProjectQuery = SqlSchema.findAll({
    Request: ListAutomationsByProjectInput,
    Result: AutomationDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          name AS "name",
          status AS "status",
          schedule_json AS "schedule",
          action_json AS "action",
          last_run_at_ms AS "lastRunAtMs",
          next_run_at_ms AS "nextRunAtMs",
          last_error_message AS "lastErrorMessage",
          created_at_ms AS "createdAtMs"
        FROM automations
        WHERE project_id = ${projectId}
        ORDER BY created_at_ms DESC, id ASC
      `,
  });

  const listAllQuery = SqlSchema.findAll({
    Request: ListAllAutomationsInput,
    Result: AutomationDbRow,
    execute: () =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          name AS "name",
          status AS "status",
          schedule_json AS "schedule",
          action_json AS "action",
          last_run_at_ms AS "lastRunAtMs",
          next_run_at_ms AS "nextRunAtMs",
          last_error_message AS "lastErrorMessage",
          created_at_ms AS "createdAtMs"
        FROM automations
        ORDER BY created_at_ms DESC, id ASC
      `,
  });

  const getByIdQuery = SqlSchema.findOneOption({
    Request: GetAutomationByIdInput,
    Result: AutomationDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          name AS "name",
          status AS "status",
          schedule_json AS "schedule",
          action_json AS "action",
          last_run_at_ms AS "lastRunAtMs",
          next_run_at_ms AS "nextRunAtMs",
          last_error_message AS "lastErrorMessage",
          created_at_ms AS "createdAtMs"
        FROM automations
        WHERE id = ${id}
      `,
  });

  const listDueQuery = SqlSchema.findAll({
    Request: ListDueAutomationsInput,
    Result: AutomationDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          id AS "id",
          project_id AS "projectId",
          name AS "name",
          status AS "status",
          schedule_json AS "schedule",
          action_json AS "action",
          last_run_at_ms AS "lastRunAtMs",
          next_run_at_ms AS "nextRunAtMs",
          last_error_message AS "lastErrorMessage",
          created_at_ms AS "createdAtMs"
        FROM automations
        WHERE status = 'enabled'
          AND next_run_at_ms IS NOT NULL
          AND next_run_at_ms <= ${now}
        ORDER BY next_run_at_ms ASC, id ASC
      `,
  });

  const listRecentRunsQuery = SqlSchema.findAll({
    Request: ListRecentRunsInput,
    Result: AutomationRunDbRow,
    execute: ({ automationId, limit }) =>
      sql`
        SELECT
          id AS "id",
          automation_id AS "automationId",
          outcome AS "outcome",
          detail AS "detail",
          thread_id AS "threadId",
          ran_at_ms AS "ranAtMs"
        FROM automation_runs
        WHERE automation_id = ${automationId}
        ORDER BY ran_at_ms DESC, id ASC
        LIMIT ${limit}
      `,
  });

  // ----- Writes ------------------------------------------------------------

  const insertQuery = SqlSchema.void({
    Request: InsertAutomationInput,
    execute: (input) =>
      sql`
        INSERT INTO automations (
          id, project_id, name, status, schedule_json, action_json,
          last_run_at_ms, next_run_at_ms, last_error_message, created_at_ms
        ) VALUES (
          ${input.id}, ${input.projectId}, ${input.name}, ${input.status},
          ${input.scheduleJson}, ${input.actionJson},
          NULL, ${input.nextRunAtMs}, NULL, ${input.createdAtMs}
        )
      `,
  });

  const deleteQuery = SqlSchema.findAll({
    Request: DeleteAutomationInput,
    Result: Schema.Struct({ id: AutomationId }),
    execute: ({ id }) =>
      sql`
        DELETE FROM automations
        WHERE id = ${id}
        RETURNING id AS "id"
      `,
  });

  const markFiredQuery = SqlSchema.void({
    Request: MarkAutomationFiredInput,
    execute: ({ id, ranAtMs, nextRunAtMs }) =>
      sql`
        UPDATE automations
        SET last_run_at_ms = ${ranAtMs},
            next_run_at_ms = ${nextRunAtMs},
            last_error_message = NULL,
            status = CASE WHEN status = 'failing' THEN 'enabled' ELSE status END
        WHERE id = ${id}
      `,
  });

  const markFailedQuery = SqlSchema.void({
    Request: MarkAutomationFailedInput,
    execute: ({ id, ranAtMs, errorMessage, disable, nextRunAtMs }) =>
      sql`
        UPDATE automations
        SET last_run_at_ms = ${ranAtMs},
            next_run_at_ms = ${disable ? null : nextRunAtMs},
            last_error_message = ${errorMessage},
            status = ${disable ? "failing" : "enabled"}
        WHERE id = ${id}
      `,
  });

  const appendRunQuery = SqlSchema.void({
    Request: AppendAutomationRunInput,
    execute: ({ id, automationId, outcome, detail, threadId, ranAtMs }) =>
      sql`
        INSERT INTO automation_runs (
          id, automation_id, outcome, detail, thread_id, ran_at_ms
        ) VALUES (
          ${id}, ${automationId}, ${outcome}, ${detail}, ${threadId}, ${ranAtMs}
        )
      `,
  });

  // Update is split into one tagged-template UPDATE per field that's
  // actually being changed. Keeps each statement static (no `sql.unsafe`)
  // at the cost of a few extra round trips on multi-field patches —
  // acceptable for the rare RPC-driven edit path.
  const updateImpl = (input: UpdateAutomationFieldsInput) =>
    Effect.gen(function* () {
      if (input.name !== undefined) {
        yield* sql`
          UPDATE automations SET name = ${input.name} WHERE id = ${input.id}
        `.pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.update:name")));
      }
      if (input.status !== undefined) {
        yield* sql`
          UPDATE automations SET status = ${input.status} WHERE id = ${input.id}
        `.pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.update:status")));
      }
      if (input.scheduleJson !== undefined) {
        yield* sql`
          UPDATE automations SET schedule_json = ${input.scheduleJson} WHERE id = ${input.id}
        `.pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.update:schedule")));
      }
      if (input.actionJson !== undefined) {
        yield* sql`
          UPDATE automations SET action_json = ${input.actionJson} WHERE id = ${input.id}
        `.pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.update:action")));
      }
      if (input.nextRunAtMs !== undefined) {
        yield* sql`
          UPDATE automations SET next_run_at_ms = ${input.nextRunAtMs} WHERE id = ${input.id}
        `.pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.update:nextRun")));
      }
      if (input.lastErrorMessage !== undefined) {
        yield* sql`
          UPDATE automations SET last_error_message = ${input.lastErrorMessage} WHERE id = ${input.id}
        `.pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.update:error")));
      }
    });

  // ----- Public shape ------------------------------------------------------

  const listByProject: AutomationRepositoryShape["listByProject"] = (input) =>
    listByProjectQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.listByProject:query",
          "AutomationRepository.listByProject:decodeRow",
        ),
      ),
      Effect.map((rows) => rows.map(rowToAutomation)),
    );

  const listAll: AutomationRepositoryShape["listAll"] = (input) =>
    listAllQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.listAll:query",
          "AutomationRepository.listAll:decodeRow",
        ),
      ),
      Effect.map((rows) => rows.map(rowToAutomation)),
    );

  const getById: AutomationRepositoryShape["getById"] = (input) =>
    getByIdQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.getById:query",
          "AutomationRepository.getById:decodeRow",
        ),
      ),
      Effect.map((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Option.none<Automation>(),
          onSome: (row) => Option.some(rowToAutomation(row)),
        }),
      ),
    );

  const insert: AutomationRepositoryShape["insert"] = (input) =>
    insertQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.insert:query",
          "AutomationRepository.insert:encodeRequest",
        ),
      ),
    );

  const update: AutomationRepositoryShape["update"] = (input) => updateImpl(input);

  const deleteById: AutomationRepositoryShape["deleteById"] = (input) =>
    deleteQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.deleteById:query",
          "AutomationRepository.deleteById:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const listDue: AutomationRepositoryShape["listDue"] = (input) =>
    listDueQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.listDue:query",
          "AutomationRepository.listDue:decodeRow",
        ),
      ),
      Effect.map((rows) => rows.map(rowToAutomation)),
    );

  const markFired: AutomationRepositoryShape["markFired"] = (input) =>
    markFiredQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.markFired:query",
          "AutomationRepository.markFired:encodeRequest",
        ),
      ),
    );

  const markFailed: AutomationRepositoryShape["markFailed"] = (input) =>
    markFailedQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.markFailed:query",
          "AutomationRepository.markFailed:encodeRequest",
        ),
      ),
    );

  const appendRun: AutomationRepositoryShape["appendRun"] = (input) =>
    appendRunQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.appendRun:query",
          "AutomationRepository.appendRun:encodeRequest",
        ),
      ),
    );

  const listRecentRuns: AutomationRepositoryShape["listRecentRuns"] = (input) =>
    listRecentRunsQuery(input).pipe(
      Effect.mapError(
        toAutomationError(
          "AutomationRepository.listRecentRuns:query",
          "AutomationRepository.listRecentRuns:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(rowToRun)),
    );

  return {
    listByProject,
    listAll,
    getById,
    insert,
    update,
    deleteById,
    listDue,
    markFired,
    markFailed,
    appendRun,
    listRecentRuns,
  } satisfies AutomationRepositoryShape;
});

export const AutomationRepositoryLive = Layer.effect(AutomationRepository, make);
