import {
  Automation,
  AutomationAction,
  AutomationId,
  AutomationRun,
  AutomationSchedule,
  AutomationStatus,
  CreateAutomationInput,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AutomationRepositoryError } from "../Errors.ts";

/**
 * Persistence layer for the Scheduled Automations feature. The schedule
 * and action shapes live in the contracts package; this repository
 * round-trips them as JSON-encoded columns so we can add new schedule
 * or action kinds later without a migration. The denormalised
 * `next_run_at_ms` column keeps the scheduler's hot query indexed.
 *
 * Methods are intentionally narrow — list/get/create/update/delete plus
 * three scheduler-only verbs (`listDue`, `markFired`, `markFailed`) and
 * the run-history append/read pair. The AutomationScheduler service in
 * `apps/server/src/automation/` is the only caller of the scheduler-only
 * verbs; the WS RPC layer uses the CRUD set.
 */

// -------------------------------------------------------------------------
// Inputs
// -------------------------------------------------------------------------

export const ListAutomationsByProjectInput = Schema.Struct({ projectId: ProjectId });
export type ListAutomationsByProjectInput = typeof ListAutomationsByProjectInput.Type;

export const ListAllAutomationsInput = Schema.Struct({});
export type ListAllAutomationsInput = typeof ListAllAutomationsInput.Type;

export const GetAutomationByIdInput = Schema.Struct({ id: AutomationId });
export type GetAutomationByIdInput = typeof GetAutomationByIdInput.Type;

export const InsertAutomationInput = Schema.Struct({
  id: AutomationId,
  name: Schema.String,
  projectId: ProjectId,
  status: AutomationStatus,
  scheduleJson: Schema.String,
  actionJson: Schema.String,
  nextRunAtMs: Schema.NullOr(Schema.Number),
  createdAtMs: Schema.Number,
});
export type InsertAutomationInput = typeof InsertAutomationInput.Type;

export const UpdateAutomationFieldsInput = Schema.Struct({
  id: AutomationId,
  name: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(AutomationStatus),
  scheduleJson: Schema.optionalKey(Schema.String),
  actionJson: Schema.optionalKey(Schema.String),
  nextRunAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  lastErrorMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type UpdateAutomationFieldsInput = typeof UpdateAutomationFieldsInput.Type;

export const DeleteAutomationInput = Schema.Struct({ id: AutomationId });
export type DeleteAutomationInput = typeof DeleteAutomationInput.Type;

export const ListDueAutomationsInput = Schema.Struct({ now: Schema.Number });
export type ListDueAutomationsInput = typeof ListDueAutomationsInput.Type;

export const MarkAutomationFiredInput = Schema.Struct({
  id: AutomationId,
  ranAtMs: Schema.Number,
  nextRunAtMs: Schema.NullOr(Schema.Number),
});
export type MarkAutomationFiredInput = typeof MarkAutomationFiredInput.Type;

export const MarkAutomationFailedInput = Schema.Struct({
  id: AutomationId,
  ranAtMs: Schema.Number,
  errorMessage: Schema.String,
  /** If true, the row's status flips to `failing` and the next-run is cleared. */
  disable: Schema.Boolean,
  /** Otherwise we keep firing: include the next scheduled time. */
  nextRunAtMs: Schema.NullOr(Schema.Number),
});
export type MarkAutomationFailedInput = typeof MarkAutomationFailedInput.Type;

export const AppendAutomationRunInput = Schema.Struct({
  id: Schema.String,
  automationId: AutomationId,
  outcome: Schema.Literals(["fired", "failed", "skipped"]),
  detail: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  ranAtMs: Schema.Number,
});
export type AppendAutomationRunInput = typeof AppendAutomationRunInput.Type;

export const ListRecentRunsInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
export type ListRecentRunsInput = typeof ListRecentRunsInput.Type;

// -------------------------------------------------------------------------
// Shape
// -------------------------------------------------------------------------

export interface AutomationRepositoryShape {
  /** CRUD ---------------------------------------------------------------- */
  readonly listByProject: (
    input: ListAutomationsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<Automation>, AutomationRepositoryError>;
  readonly listAll: (
    input: ListAllAutomationsInput,
  ) => Effect.Effect<ReadonlyArray<Automation>, AutomationRepositoryError>;
  readonly getById: (
    input: GetAutomationByIdInput,
  ) => Effect.Effect<Option.Option<Automation>, AutomationRepositoryError>;
  readonly insert: (
    input: InsertAutomationInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly update: (
    input: UpdateAutomationFieldsInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly deleteById: (
    input: DeleteAutomationInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;

  /** Scheduler ----------------------------------------------------------- */
  readonly listDue: (
    input: ListDueAutomationsInput,
  ) => Effect.Effect<ReadonlyArray<Automation>, AutomationRepositoryError>;
  readonly markFired: (
    input: MarkAutomationFiredInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly markFailed: (
    input: MarkAutomationFailedInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;

  /** Run history --------------------------------------------------------- */
  readonly appendRun: (
    input: AppendAutomationRunInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly listRecentRuns: (
    input: ListRecentRunsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  /**
   * Delete `automation_runs` rows older than the given ms-cutoff.
   * Called periodically by the scheduler so a high-frequency
   * automation doesn't grow the table unbounded. Returns the number
   * of rows deleted so we can log loud-enough when we're catching up.
   */
  readonly pruneRunsOlderThan: (input: {
    readonly olderThanMs: number;
  }) => Effect.Effect<number, AutomationRepositoryError>;
}

export class AutomationRepository extends Context.Service<
  AutomationRepository,
  AutomationRepositoryShape
>()("t3/persistence/Services/Automations/AutomationRepository") {}

// -------------------------------------------------------------------------
// Helpers shared between the layer and the scheduler
// -------------------------------------------------------------------------

/**
 * Hydrate the JSON columns into the public `Automation` shape. Failures
 * to parse are caught upstream; this helper assumes the JSON has already
 * been decoded.
 */
export function rebuildAutomation(args: {
  id: AutomationId;
  name: string;
  projectId: ProjectId;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  action: AutomationAction;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastErrorMessage: string | null;
  createdAtMs: number;
}): Automation {
  return {
    id: args.id,
    name: args.name as Automation["name"],
    projectId: args.projectId,
    status: args.status,
    schedule: args.schedule,
    action: args.action,
    lastRunAt: args.lastRunAtMs,
    nextRunAt: args.nextRunAtMs,
    lastErrorMessage: args.lastErrorMessage,
    createdAt: args.createdAtMs,
  };
}

/** Helper that wraps the `CreateAutomationInput` patch into JSON columns. */
export function encodeForInsert(
  input: CreateAutomationInput,
  args: { id: AutomationId; nextRunAtMs: number | null; createdAtMs: number },
): InsertAutomationInput {
  return {
    id: args.id,
    name: input.name,
    projectId: input.projectId,
    status: input.enabled ? "enabled" : "disabled",
    scheduleJson: JSON.stringify(input.schedule),
    actionJson: JSON.stringify(input.action),
    nextRunAtMs: args.nextRunAtMs,
    createdAtMs: args.createdAtMs,
  };
}
