import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-project Kanban board tables.
 *
 * `kanban_cards` is the canonical row — schedule + blocked_by are stored
 * as JSON so we can evolve the shape without further migrations.
 *
 * `kanban_card_artifacts` accumulates per-run outputs (diffs, screenshots,
 * PR links, commit SHAs). Capped read by the UI (latest N per card); the
 * full history is the audit log.
 *
 * `kanban_card_notes` is the journal — Claude appends notes on column
 * moves, work-in-progress updates, etc. Author column distinguishes
 * agent-written, system-written (column moves), and user-written (v2).
 *
 * Indexes:
 *  - `idx_kanban_cards_project_column` — Today + Full board queries.
 *  - `idx_kanban_cards_thread` — "find card bound to this thread" reverse lookup.
 *  - `idx_kanban_card_artifacts_card` / notes_card — detail screen.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      column_name TEXT NOT NULL,
      priority TEXT NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      last_thread_id TEXT,
      schedule_json TEXT,
      schedule_automation_id TEXT,
      blocked_by_json TEXT,
      sort_order REAL NOT NULL,
      tasks_mirror_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      done_at_ms INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_project_column
    ON kanban_cards(project_id, column_name, sort_order ASC, created_at_ms ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_thread
    ON kanban_cards(thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_schedule
    ON kanban_cards(schedule_automation_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_card_artifacts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_card_artifacts_card
    ON kanban_card_artifacts(card_id, created_at_ms DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_card_notes (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_card_notes_card
    ON kanban_card_notes(card_id, created_at_ms DESC)
  `;
});
