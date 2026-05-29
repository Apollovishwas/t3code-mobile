import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Per-project sweep schedule. v1 keeps schedules in-memory only — they
 * reset on server restart. Persistence lands when we add a dedicated
 * `wiki_schedules` table; for now the user can re-enable a schedule
 * from the Settings → Wiki panel after a deploy.
 */
export interface WikiSchedule {
  readonly projectId: ProjectId;
  readonly enabled: boolean;
  /** How often to fire, in whole minutes. Min 5, max 24h. */
  readonly intervalMinutes: number;
  /** When the schedule was last started — used to compute next fire. */
  readonly startedAtMs: number;
  /** Last fired-at timestamp, null if it hasn't run yet. */
  readonly lastFiredAtMs: number | null;
  /** Last outcome — populated by the scheduler tick. */
  readonly lastOutcome:
    | { readonly kind: "success"; readonly capturedMessages: number }
    | { readonly kind: "skipped"; readonly reason: string }
    | { readonly kind: "failed"; readonly error: string }
    | null;
}

export interface WikiSchedulerShape {
  /** List all currently-tracked schedules. */
  readonly list: () => Effect.Effect<ReadonlyArray<WikiSchedule>>;

  /** Upsert a project's schedule. Setting `enabled: false` keeps the row
   *  visible but skips ticks until re-enabled. */
  readonly upsert: (
    input: { readonly projectId: ProjectId; readonly enabled: boolean; readonly intervalMinutes: number },
  ) => Effect.Effect<WikiSchedule>;

  /** Forget a project's schedule entirely. */
  readonly remove: (projectId: ProjectId) => Effect.Effect<void>;

  /**
   * Fire a sweep for one project right now, on demand — the "Sync now"
   * button. Bypasses both the interval clock and the hot-thread quiet
   * window (the user explicitly asked for it). Does NOT require a
   * schedule to exist for the project. Returns the outcome so the UI
   * can show "captured" / "no thread" / "failed" inline.
   */
  readonly runOnce: (
    projectId: ProjectId,
  ) => Effect.Effect<NonNullable<WikiSchedule["lastOutcome"]>>;

  /** Start the background tick fiber. Call once at server startup. */
  readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
}

export class WikiScheduler extends Context.Service<WikiScheduler, WikiSchedulerShape>()(
  "t3/wiki/WikiScheduler",
) {}
