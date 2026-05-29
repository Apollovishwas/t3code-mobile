import type { ProjectId } from "@t3tools/contracts";
import { CommandId, IsoDateTime, MessageId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WikiScheduler,
  type WikiSchedule,
  type WikiSchedulerShape,
} from "../Services/WikiScheduler.ts";

/**
 * Wiki sweep scheduler.
 *
 * Every 60s the tick walks enabled schedules. For each one that's due:
 *   1. Find the project's most recently-touched thread.
 *   2. Skip if the thread is "hot" (touched in the last QUIET_THRESHOLD_MS)
 *      — we don't want to interrupt an active session.
 *   3. Dispatch a `thread.turn.start` with the WIKI_REVIEW_PROMPT, using
 *      the same `OrchestrationEngineService` path a user-initiated send
 *      uses. The cost is a normal turn billed through the user's existing
 *      Claude Code subscription — NO Agent SDK subprocess, no API key.
 *   4. Record outcome on the in-memory schedule row.
 *
 * The agent receives the wiki system-prompt block on every turn (see
 * `ClaudeAdapter.buildWikiSystemPromptAppend`), so it already knows what
 * to do: scan recent activity, write/update pages in `.t3/wiki/`,
 * cross-link with `[[wikilinks]]`, exit silently when nothing meets the
 * notability bar.
 *
 * Schedules remain in-memory (no migration yet); resets on server restart.
 * Re-enable from Settings → Wiki after a deploy.
 */

const TICK_INTERVAL = Duration.seconds(60);

/** Don't interrupt a thread touched in the last 5 minutes. */
const QUIET_THRESHOLD_MS = 5 * 60 * 1000;

/** The prompt fired on every scheduled tick. */
const WIKI_REVIEW_PROMPT = [
  "/wiki:sync — automated wiki sweep.",
  "",
  "Review the recent turns of this thread. For any decisions, gotchas,",
  "architectural choices, or facts about the codebase that future Claude",
  "sessions would benefit from knowing, write or update a markdown page",
  "under `.t3/wiki/<slug>.md` using your Write/Edit tools.",
  "",
  "Rules:",
  "- Skip trivia. If nothing in the recent activity meets the notability",
  "  bar, say so in one line and stop.",
  "- Reuse existing topic slugs where sensible (Glob `.t3/wiki/*.md` first).",
  "- Bump `updated_at` on every edit.",
  "- Cross-link related pages with `[[slug]]`.",
  "- Filenames starting with `_` are reserved — never write to them.",
].join("\n");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const snapshot = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;

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

      // ----- pick the candidate thread ------------------------------------
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
      const sortedThreads = shell.threads
        .filter((t) => t.projectId === schedule.projectId)
        .sort((a, b) => {
          const av = typeof a.updatedAt === "number" ? a.updatedAt : Date.parse(String(a.updatedAt));
          const bv = typeof b.updatedAt === "number" ? b.updatedAt : Date.parse(String(b.updatedAt));
          return (bv || 0) - (av || 0);
        });
      const candidate = sortedThreads[0];

      let outcome: WikiSchedule["lastOutcome"] = null;

      if (!candidate) {
        outcome = { kind: "skipped", reason: "No threads in this project yet" };
      } else {
        // ----- idempotency: skip hot threads ----------------------------
        const candidateUpdatedMs =
          typeof candidate.updatedAt === "number"
            ? candidate.updatedAt
            : Date.parse(String(candidate.updatedAt));
        const isHot =
          Number.isFinite(candidateUpdatedMs) &&
          candidateUpdatedMs > nowMs - QUIET_THRESHOLD_MS;

        if (isHot) {
          outcome = {
            kind: "skipped",
            reason: `Thread is active (touched ${Math.round((nowMs - candidateUpdatedMs) / 1000)}s ago)`,
          };
        } else {
          // ----- dispatch the wiki-review prompt ------------------------
          const commandId = CommandId.make(`wiki-sweep:${schedule.projectId}:${nowMs}`);
          const messageId = MessageId.make(`wiki-sweep-${schedule.projectId}-${nowMs}`);
          const createdAt = yield* nowIso.pipe(Effect.map(IsoDateTime.make));
          outcome = yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId,
              threadId: ThreadId.make(candidate.id),
              message: {
                messageId,
                role: "user",
                text: WIKI_REVIEW_PROMPT,
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt,
            })
            .pipe(
              Effect.match({
                onSuccess: (): NonNullable<WikiSchedule["lastOutcome"]> => ({
                  kind: "success",
                  capturedMessages: 1,
                }),
                onFailure: (err): NonNullable<WikiSchedule["lastOutcome"]> => ({
                  kind: "failed",
                  error:
                    err instanceof Error
                      ? err.message
                      : typeof err === "object" && err !== null && "message" in err
                        ? String((err as { message: unknown }).message)
                        : "Unknown dispatch error",
                }),
              }),
            );
        }
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
        quietThresholdMs: QUIET_THRESHOLD_MS,
      });
    });

  return { list, upsert, remove, start } satisfies WikiSchedulerShape;
});

export const WikiSchedulerLive = Layer.effect(WikiScheduler, make);
