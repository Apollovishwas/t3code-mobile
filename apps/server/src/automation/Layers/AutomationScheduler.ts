import {
  Automation,
  AutomationId,
  CommandId,
  IsoDateTime,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { PushNotifications } from "../../push/Services/PushNotifications.ts";
import { AutomationRepository } from "../../persistence/Services/Automations.ts";
import { KanbanRepository } from "../../persistence/Services/KanbanBoard.ts";
import type { KanbanCardId } from "@t3tools/contracts";
import { computeNextFireAt } from "../scheduleMath.ts";
import {
  AutomationScheduler,
  type AutomationSchedulerShape,
} from "../Services/AutomationScheduler.ts";

/**
 * How often the scheduler checks for due automations. 30s is a good
 * balance — high-frequency enough that "every minute" interval schedules
 * fire on time, low-frequency enough that an idle server isn't pinging
 * SQLite hundreds of times per minute.
 */
const SWEEP_INTERVAL_MS = 30_000;

interface DispatchOutcome {
  readonly outcome: "fired" | "failed";
  readonly detail: string | null;
  readonly threadId: string | null;
}

const make = Effect.gen(function* () {
  const repo = yield* AutomationRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const push = yield* PushNotifications;
  const kanban = yield* KanbanRepository;

  /**
   * Dispatch a single automation's action. For `send-prompt` this means
   * synthesising a `thread.turn.start` command and pushing it through
   * the orchestration engine — the same path a user-initiated send
   * follows. For `resume-and-prompt` we currently return a v1-not-yet
   * failure; lifting that requires extracting the bootstrap helper
   * currently embedded inside ws.ts.
   */
  /**
   * Resolve a card-bound automation to the same {threadId, prompt} shape
   * a normal send-prompt action takes. Two failure modes are surfaced
   * as `null` so the caller emits a clean error notification:
   *  - The card no longer exists (user or Claude deleted it without
   *    unscheduling — the scheduler disables on failure, so we just
   *    fail once and move on).
   *  - The card has no bound thread (user hasn't opened a thread for
   *    it yet). The dispatcher records a clear error in this case so
   *    the user knows what to do.
   */
  type RunCardResolution =
    | { reason: "missing-card" }
    | {
        reason: "no-thread";
        card: { readonly title: string };
      }
    | {
        reason: "ok";
        threadId: string;
        prompt: string;
        card: { readonly title: string };
      };

  const resolveRunCard = (
    cardId: KanbanCardId,
  ): Effect.Effect<RunCardResolution, never> =>
    Effect.gen(function* () {
      const cardOpt = yield* kanban.getCard({ id: cardId }).pipe(
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      const card = Option.getOrUndefined(cardOpt);
      if (!card) return { reason: "missing-card" } satisfies RunCardResolution;
      if (!card.threadId) {
        return {
          reason: "no-thread",
          card: { title: card.title as string },
        } satisfies RunCardResolution;
      }
      // Compose the prompt from the card's title + description so the
      // agent has full context. We deliberately don't include a long
      // "run card X" preamble — the agent already knows from the system
      // prompt that scheduled work fires the card's description.
      const promptParts: string[] = [];
      promptParts.push(`(Scheduled run of board card "${card.title}".)`);
      if (card.description && card.description.trim().length > 0) {
        promptParts.push("");
        promptParts.push(card.description);
      }
      return {
        reason: "ok",
        threadId: card.threadId as string,
        prompt: promptParts.join("\n"),
        card: { title: card.title as string },
      } satisfies RunCardResolution;
    });

  const dispatchAutomation = (
    automation: Automation,
    nowMs: number,
  ): Effect.Effect<DispatchOutcome, never> =>
    Effect.gen(function* () {
      const action = automation.action;
      if (action.kind === "resume-and-prompt") {
        return {
          outcome: "failed" as const,
          detail:
            "resume-and-prompt action is not supported in automations v1 — use send-prompt with an existing thread.",
          threadId: null,
        };
      }
      // run-card: resolve to (threadId, prompt) via the bound card,
      // then dispatch through the same orchestration path as a normal
      // send-prompt automation.
      if (action.kind === "run-card") {
        const resolved = yield* resolveRunCard(action.cardId as KanbanCardId);
        if (resolved.reason === "missing-card") {
          return {
            outcome: "failed" as const,
            detail: `Card ${action.cardId} no longer exists — automation disabled.`,
            threadId: null,
          };
        }
        if (resolved.reason === "no-thread") {
          return {
            outcome: "failed" as const,
            detail: `Card "${resolved.card.title}" has no bound thread — open a thread for the card before scheduling.`,
            threadId: null,
          };
        }
        const commandId = CommandId.make(`automation:${automation.id}:${nowMs}`);
        const messageId = MessageId.make(`auto-${automation.id}-${nowMs}`);
        const createdAt = yield* nowIso.pipe(Effect.map(IsoDateTime.make));
        return yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: ThreadId.make(resolved.threadId),
            message: {
              messageId,
              role: "user",
              text: resolved.prompt,
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          })
          .pipe(
            Effect.match({
              onSuccess: (res): DispatchOutcome => ({
                outcome: "fired",
                detail: `Card "${resolved.card.title}" dispatched at sequence ${res.sequence}`,
                threadId: resolved.threadId as string,
              }),
              onFailure: (err): DispatchOutcome => {
                const detail =
                  err instanceof Error
                    ? err.message
                    : typeof err === "object" && err !== null && "message" in err
                      ? String((err as { message: unknown }).message)
                      : "Unknown dispatch error";
                return { outcome: "failed", detail, threadId: null };
              },
            }),
          );
      }
      // Build the same command shape that a user-initiated send produces.
      const commandId = CommandId.make(`automation:${automation.id}:${nowMs}`);
      const messageId = MessageId.make(`auto-${automation.id}-${nowMs}`);
      const createdAt = yield* nowIso.pipe(Effect.map(IsoDateTime.make));
      return yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId,
          threadId: action.threadId,
          message: {
            messageId,
            role: "user",
            text: action.prompt,
            attachments: [],
          },
          // Leave model/runtime/interaction mode undefined so the
          // orchestration engine picks up the thread's existing settings.
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        })
        .pipe(
          Effect.match({
            onSuccess: (res): DispatchOutcome => ({
              outcome: "fired",
              detail: `dispatched turn at sequence ${res.sequence}`,
              threadId: action.threadId as string,
            }),
            onFailure: (err): DispatchOutcome => {
              const detail =
                err instanceof Error
                  ? err.message
                  : typeof err === "object" && err !== null && "message" in err
                    ? String((err as { message: unknown }).message)
                    : "Unknown dispatch error";
              return { outcome: "failed", detail, threadId: null };
            },
          }),
        );
    });

  /** Finalise a fire by writing the outcome + recomputing the next fire. */
  const recordOutcome = (
    automation: Automation,
    nowMs: number,
    outcome: DispatchOutcome,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      // Run-history entry.
      const runId = `run-${automation.id}-${nowMs}`;
      yield* repo
        .appendRun({
          id: runId,
          automationId: automation.id,
          outcome: outcome.outcome,
          detail: outcome.detail,
          threadId: outcome.threadId,
          ranAtMs: nowMs,
        })
        .pipe(Effect.ignoreCause({ log: true }));

      if (outcome.outcome === "fired") {
        const next = computeNextFireAt(automation.schedule, nowMs, nowMs);
        yield* repo
          .markFired({ id: automation.id, ranAtMs: nowMs, nextRunAtMs: next })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* push
          .broadcast({
            title: "Automation fired",
            body: `${automation.name} started a turn.`,
            tag: `t3code-automation-fired:${automation.id}`,
            url: "/",
          })
          .pipe(Effect.ignoreCause({ log: true }));
      } else {
        // Disable on failure — least surprising mobile behaviour. User
        // can re-enable from the Settings panel after fixing the cause.
        yield* repo
          .markFailed({
            id: automation.id,
            ranAtMs: nowMs,
            errorMessage: outcome.detail ?? "Unknown failure",
            disable: true,
            nextRunAtMs: null,
          })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* push
          .broadcast({
            title: "Automation failed",
            body: `${automation.name} was disabled — ${outcome.detail ?? "unknown error"}`,
            tag: `t3code-automation-failed:${automation.id}`,
            url: "/",
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
    });

  /** One sweep — fetch all due automations and dispatch each in series.
   *  Runs the runs-history janitor at the tail of the sweep so we share
   *  the same fiber and don't pay for a second forked schedule. */
  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const due = yield* repo.listDue({ now: nowMs }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("automation.scheduler.listDue-failed", { cause }).pipe(
          Effect.as<readonly Automation[]>([]),
        ),
      ),
    );
    if (due.length > 0) {
      yield* Effect.logDebug("automation.scheduler.sweep", { dueCount: due.length });
      for (const automation of due) {
        const outcome = yield* dispatchAutomation(automation, nowMs);
        yield* recordOutcome(automation, nowMs, outcome);
      }
    }
    yield* maybePruneRuns;
  });

  /**
   * Periodic janitor for `automation_runs`. The table grew unbounded
   * before this — a 5-minute-cadence automation inserts ~100k rows/year.
   * We delete anything older than 30 days. Runs once an hour, sharing
   * the same sweep fiber so we don't pay for another forked schedule.
   */
  const PRUNE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const PRUNE_EVERY_MS = 60 * 60 * 1000;
  let lastPruneAtMs = 0;
  const maybePruneRuns = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (nowMs - lastPruneAtMs < PRUNE_EVERY_MS) return;
    lastPruneAtMs = nowMs;
    const deleted = yield* repo
      .pruneRunsOlderThan({ olderThanMs: nowMs - PRUNE_RETENTION_MS })
      .pipe(Effect.catch(() => Effect.succeed(0)));
    if (deleted > 0) {
      yield* Effect.logInfo("automation.scheduler.runs-pruned", { deleted });
    }
  });

  const start: AutomationSchedulerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        sweep.pipe(
          Effect.catch((error: unknown) =>
            Effect.logWarning("automation.scheduler.sweep-failed", { error }),
          ),
          Effect.catchDefect((defect: unknown) =>
            Effect.logWarning("automation.scheduler.sweep-defect", { defect }),
          ),
          Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))),
        ),
      );
      yield* Effect.logInfo("automation.scheduler.started", {
        sweepIntervalMs: SWEEP_INTERVAL_MS,
      });
    });

  const runNow: AutomationSchedulerShape["runNow"] = (input) =>
    Effect.gen(function* () {
      const automationOpt = yield* repo
        .getById({ id: input.id as AutomationId })
        .pipe(
          Effect.catch(() => Effect.succeed(Option.none<Automation>())),
        );
      const automation = Option.getOrUndefined(automationOpt);
      if (!automation) {
        return {
          outcome: "failed" as const,
          detail: "Automation not found",
        };
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const outcome = yield* dispatchAutomation(automation, nowMs);
      yield* recordOutcome(automation, nowMs, outcome);
      return { outcome: outcome.outcome, detail: outcome.detail };
    });

  return { start, runNow } satisfies AutomationSchedulerShape;
});

export const AutomationSchedulerLive = Layer.effect(AutomationScheduler, make);
