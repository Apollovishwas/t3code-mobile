import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Scheduled automations table. Holds the schedule + action definitions
 * that the AutomationScheduler service ticks against. Schedule and action
 * are stored as JSON so the column list doesn't churn when we add new
 * schedule kinds or action kinds — the contract package owns the shape.
 *
 * `next_run_at_ms` is denormalised so the scheduler's hot path is a
 * single indexed query (`WHERE status = 'enabled' AND next_run_at_ms <=
 * ?`) rather than walking every row and recomputing. The status column
 * lets us mark a row as `failing` after repeated dispatch errors without
 * losing the user's original schedule.
 *
 * A sibling `automation_runs` table records each fire's outcome so the UI
 * can show a small recent-history strip per automation without scanning
 * server logs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      last_run_at_ms INTEGER,
      next_run_at_ms INTEGER,
      last_error_message TEXT,
      created_at_ms INTEGER NOT NULL
    )
  `;

  // Hot-path index for the scheduler's "what's due?" query.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automations_due
    ON automations(status, next_run_at_ms)
  `;

  // For the project-scoped listing in the UI.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automations_project
    ON automations(project_id, created_at_ms DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      thread_id TEXT,
      ran_at_ms INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_recent
    ON automation_runs(automation_id, ran_at_ms DESC)
  `;
});
