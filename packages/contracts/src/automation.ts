/**
 * Scheduled Automations contract — server-side cron-style triggers that
 * fire prompts into existing threads (or into newly-created threads with
 * a resumed Claude session). Each fire goes through the same turn pipeline
 * a manual send uses, so the activity stream + push notifications all just
 * work.
 *
 * v1 deliberately avoids raw cron syntax in favour of two preset shapes —
 * `interval` (every N minutes) and `daily` (HH:MM, optionally weekdays
 * only). The next-fire timestamp is recomputed in plain JS on every fire,
 * keeping the dependency surface small. Raw cron can be added as a third
 * `schedule.kind` later without breaking existing rows.
 *
 * Schedule arithmetic lives in `apps/server/src/automation/scheduleMath.ts`
 * — this contract just declares the shapes that round-trip between server
 * and client.
 */

import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// -------------------------------------------------------------------------
// Identifier
// -------------------------------------------------------------------------

export const AutomationId = Schema.String.pipe(Schema.brand("AutomationId"));
export type AutomationId = typeof AutomationId.Type;

// -------------------------------------------------------------------------
// Schedule
// -------------------------------------------------------------------------

/**
 * v1 only supports `interval` (every N minutes). A `daily` HH:MM
 * variant is planned and will land as a third union member without a
 * migration — the schedule column is JSON.
 */
export const AutomationIntervalSchedule = Schema.Struct({
  kind: Schema.Literal("interval"),
  /** How often to fire, in whole minutes. Min 1, max 30 days. */
  minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 * 24 * 30 })),
});
export type AutomationIntervalSchedule = typeof AutomationIntervalSchedule.Type;

export const AutomationSchedule = Schema.Union([AutomationIntervalSchedule]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

// -------------------------------------------------------------------------
// Action
// -------------------------------------------------------------------------

/** Send the prompt to a specific existing thread. */
export const AutomationSendPromptAction = Schema.Struct({
  kind: Schema.Literal("send-prompt"),
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString,
});
export type AutomationSendPromptAction = typeof AutomationSendPromptAction.Type;

/**
 * Create a brand-new thread (optionally resuming a Claude session) and
 * send the prompt as the first user message. `resumeSessionId` reuses
 * the resume-session feature shipped earlier — set it to fork off an
 * existing Claude session, leave `null` for a fresh thread.
 */
export const AutomationResumeAndPromptAction = Schema.Struct({
  kind: Schema.Literal("resume-and-prompt"),
  projectId: ProjectId,
  resumeSessionId: Schema.NullOr(Schema.String),
  /** Working directory for the new thread; falls back to project's cwd. */
  cwd: Schema.NullOr(Schema.String),
  /** Title for the new thread — keeps the sidebar legible. */
  titleSeed: Schema.NullOr(TrimmedNonEmptyString),
  prompt: TrimmedNonEmptyString,
});
export type AutomationResumeAndPromptAction = typeof AutomationResumeAndPromptAction.Type;

/**
 * Fire a Kanban card's description into the card's bound thread. Created
 * server-side when a card is scheduled (the Kanban HTTP endpoint inserts
 * the automation row); the card holds a pointer back to this automation's
 * id so it can be unscheduled cleanly.
 *
 * The `cardId` field is the source of truth for what runs — the
 * scheduler looks up the card at fire time so prompt edits + thread
 * rebindings take effect on the next tick without rewriting the row.
 */
export const AutomationRunCardAction = Schema.Struct({
  kind: Schema.Literal("run-card"),
  cardId: Schema.String,
});
export type AutomationRunCardAction = typeof AutomationRunCardAction.Type;

export const AutomationAction = Schema.Union([
  AutomationSendPromptAction,
  AutomationResumeAndPromptAction,
  AutomationRunCardAction,
]);
export type AutomationAction = typeof AutomationAction.Type;

// -------------------------------------------------------------------------
// Record (server-side row)
// -------------------------------------------------------------------------

export const AutomationStatus = Schema.Literals(["enabled", "disabled", "failing"]);
export type AutomationStatus = typeof AutomationStatus.Type;

export const Automation = Schema.Struct({
  id: AutomationId,
  name: TrimmedNonEmptyString,
  projectId: ProjectId,
  status: AutomationStatus,
  schedule: AutomationSchedule,
  action: AutomationAction,
  /** ms-epoch of the most recent fire (success OR failure). */
  lastRunAt: Schema.NullOr(Schema.Number),
  /** ms-epoch of the next scheduled fire. Null = never (disabled / failing). */
  nextRunAt: Schema.NullOr(Schema.Number),
  /** Short message captured if the last fire failed (rendered in the UI). */
  lastErrorMessage: Schema.NullOr(Schema.String),
  /** ms-epoch of creation, for default sort order. */
  createdAt: Schema.Number,
});
export type Automation = typeof Automation.Type;

// -------------------------------------------------------------------------
// Run history
// -------------------------------------------------------------------------

export const AutomationRunOutcome = Schema.Literals(["fired", "failed", "skipped"]);
export type AutomationRunOutcome = typeof AutomationRunOutcome.Type;

export const AutomationRun = Schema.Struct({
  id: Schema.String,
  automationId: AutomationId,
  outcome: AutomationRunOutcome,
  /** Free-form note describing the outcome — surfaced in the UI. */
  detail: Schema.NullOr(Schema.String),
  /** Thread the fire landed on (null when the action failed before dispatch). */
  threadId: Schema.NullOr(ThreadId),
  ranAt: Schema.Number,
});
export type AutomationRun = typeof AutomationRun.Type;

// -------------------------------------------------------------------------
// Patches (for create/update RPCs)
// -------------------------------------------------------------------------

export const CreateAutomationInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  projectId: ProjectId,
  schedule: AutomationSchedule,
  action: AutomationAction,
  enabled: Schema.Boolean,
});
export type CreateAutomationInput = typeof CreateAutomationInput.Type;

export const UpdateAutomationInput = Schema.Struct({
  id: AutomationId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  schedule: Schema.optionalKey(AutomationSchedule),
  action: Schema.optionalKey(AutomationAction),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type UpdateAutomationInput = typeof UpdateAutomationInput.Type;
