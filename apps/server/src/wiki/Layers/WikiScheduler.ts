import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WikiWriter } from "../Services/WikiWriter.ts";
import {
  WikiScheduler,
  type WikiSchedule,
  type WikiSchedulerShape,
} from "../Services/WikiScheduler.ts";

/**
 * v1 in-memory scheduler.
 *
 * Ticks every 60s. On each tick: walk schedules, for each enabled one
 * whose `lastFiredAtMs + intervalMs < now`, find the most-recently
 * touched active thread in that project, then call
 * `WikiWriter.captureFromThread`. Records the outcome on the schedule
 * row so the Settings panel can render "last run" diagnostics.
 *
 * Persistence is deferred — see [[scheduled-automations-feature]] for
 * the precedent we'd follow when adding a `wiki_schedules` table.
 */

const TICK_INTERVAL = Duration.seconds(60);

const make = Effect.gen(function* () {
  const writer = yield* WikiWriter;
  const snapshot = yield* ProjectionSnapshotQuery;

  const schedules = yield* Ref.make<ReadonlyMap<ProjectId, WikiSchedule>>(new Map());

  const list: WikiSchedulerShape["list"] = () =>
    Ref.get(schedules).pipe(Effect.map((map) => Array.from(map.values())));

  const upsert: WikiSchedulerShape["upsert"] = ({ projectId, enabled, intervalMinutes }) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const existing = (yield* Ref.get(schedules)).get(projectId);
      const next: WikiSchedule = {
        projectId,
        enabled,
        intervalMinutes: Math.max(5, Math.min(60 * 24, intervalMinutes)),
        startedAtMs: existing?.startedAtMs ?? nowMs,
        lastFiredAtMs: existing?.lastFiredAtMs ?? null,
        lastOutcome: existing?.lastOutcome ?? null,
      };
      yield* Ref.update(schedules, (map) => {
        const copy = new Map(map);
        copy.set(projectId, next);
        return copy;
      });
      return next;
    });

  const remove: WikiSchedulerShape["remove"] = (projectId) =>
    Ref.update(schedules, (map) => {
      const copy = new Map(map);
      copy.delete(projectId);
      return copy;
    });

  /** One tick: fire any due schedules. */
  const tick = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(schedules);
    for (const schedule of current.values()) {
      if (!schedule.enabled) continue;
      const intervalMs = schedule.intervalMinutes * 60_000;
      const lastFired = schedule.lastFiredAtMs ?? schedule.startedAtMs;
      if (lastFired + intervalMs > nowMs) continue;

      // Find the most-recently-touched active thread in the project.
      const shellResult = yield* snapshot
        .getShellSnapshot()
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (!shellResult) continue;
      const shell = shellResult as unknown as {
        threads: ReadonlyArray<{
          readonly id: string;
          readonly projectId?: string;
          readonly updatedAt?: string | number;
        }>;
      };
      const candidate = shell.threads
        .filter((t) => t.projectId === schedule.projectId)
        .sort((a, b) => {
          const av = typeof a.updatedAt === "number" ? a.updatedAt : Date.parse(String(a.updatedAt));
          const bv = typeof b.updatedAt === "number" ? b.updatedAt : Date.parse(String(b.updatedAt));
          return (bv || 0) - (av || 0);
        })[0];

      let outcome: WikiSchedule["lastOutcome"] = null;
      if (!candidate) {
        outcome = { kind: "skipped", reason: "No active thread to capture" };
      } else {
        const writeResult = yield* writer
          .captureFromThread({
            projectId: schedule.projectId,
            threadId: candidate.id as never,
          })
          .pipe(
            Effect.match({
              onFailure: (cause) => ({
                kind: "failed" as const,
                error: String((cause as { message?: string })?.message ?? cause),
              }),
              onSuccess: (r) => ({
                kind: "success" as const,
                capturedMessages: r.exitCode === 0 ? 1 : 0,
              }),
            }),
          );
        outcome = writeResult;
      }

      yield* Ref.update(schedules, (map) => {
        const copy = new Map(map);
        copy.set(schedule.projectId, {
          ...schedule,
          lastFiredAtMs: nowMs,
          lastOutcome: outcome,
        });
        return copy;
      });
    }
  });

  const start: WikiSchedulerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        tick.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("wiki.scheduler.tick-failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
        ),
      );
      yield* Effect.logInfo("wiki.scheduler.started", {
        tickIntervalMs: Duration.toMillis(TICK_INTERVAL),
      });
    });

  return { list, upsert, remove, start } satisfies WikiSchedulerShape;
});

export const WikiSchedulerLive = Layer.effect(WikiScheduler, make);
