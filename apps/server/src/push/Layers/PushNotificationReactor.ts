import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { PushNotifications } from "../Services/PushNotifications.ts";
import {
  PushNotificationReactor,
  type PushNotificationReactorShape,
} from "../Services/PushNotificationReactor.ts";

/** Pull the labels of completed plan steps out of a turn.plan.updated payload. */
function completedPlanSteps(activityPayload: unknown): string[] {
  if (typeof activityPayload !== "object" || activityPayload === null) {
    return [];
  }
  const plan = (activityPayload as { readonly plan?: unknown }).plan;
  if (!Array.isArray(plan)) {
    return [];
  }
  const steps: string[] = [];
  for (const item of plan) {
    if (typeof item === "object" && item !== null) {
      const step = (item as { step?: unknown }).step;
      const status = (item as { status?: unknown }).status;
      if (typeof step === "string" && status === "completed") {
        steps.push(step);
      }
    }
  }
  return steps;
}

/** True when a turn.plan.updated payload contains at least one pending step
 *  — i.e., the plan has been written and is waiting on either further
 *  agent work or user approval. Used to gate the "Plan ready" push. */
function planHasPendingSteps(activityPayload: unknown): boolean {
  if (typeof activityPayload !== "object" || activityPayload === null) return false;
  const plan = (activityPayload as { readonly plan?: unknown }).plan;
  if (!Array.isArray(plan)) return false;
  return plan.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const status = (item as { status?: unknown }).status;
    return status === "in_progress" || status === "pending";
  });
}

/** Best-effort extraction of a short human label from an activity payload —
 *  used as the notification `body`. Pulls the first string-ish field we
 *  recognize, otherwise returns a generic fallback. */
function shortPayloadLabel(
  activityPayload: unknown,
  fallback: string,
): string {
  if (typeof activityPayload !== "object" || activityPayload === null) return fallback;
  const candidates = ["label", "title", "question", "prompt", "summary", "tool", "command"];
  for (const key of candidates) {
    const value = (activityPayload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.length > 140 ? `${value.slice(0, 137)}…` : value;
    }
  }
  return fallback;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const push = yield* PushNotifications;

  // Per (thread+turn) set of plan steps we've already announced as completed,
  // so each finished task pushes exactly once.
  const notifiedSteps = new Map<string, Set<string>>();
  // Per (thread+turn) marker that we've already announced "plan ready"
  // — fires once per turn on the first plan.updated event with pending work.
  const announcedPlanReady = new Set<string>();

  const start: PushNotificationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.turn-diff-completed") {
          return push
            .broadcast({
              title: "Agent finished",
              body: "Your agent finished responding in T3 Code.",
              tag: "t3code-agent-finished",
              url: "/",
            })
            .pipe(Effect.catch(() => Effect.void));
        }

        // Granular categories: needs-input on approval / question, plan-ready
        // on first plan write, in addition to the existing per-task push.
        // Each category gets a distinct title and tag so the OS notification
        // UI groups them apart; the browser-level tag also dedupes repeated
        // pushes with the same requestId (replaces instead of stacks).
        if (event.type === "thread.activity-appended") {
          const activity = event.payload.activity;
          const threadId = event.payload.threadId;
          const turnId = activity.turnId ?? "no-turn";

          // ---- needs-input: agent is blocked waiting on the user. ---------
          if (activity.kind === "approval.requested") {
            // The activity payload may carry a requestId — fall back to the
            // activity id so each distinct approval gets its own tag and
            // notifications don't pile up when the agent retries.
            const requestId =
              (activity.payload as { requestId?: unknown } | undefined)?.requestId;
            const tagSuffix = typeof requestId === "string" ? requestId : threadId;
            return push
              .broadcast({
                title: "Approval needed",
                body: shortPayloadLabel(
                  activity.payload,
                  "Agent wants permission to proceed.",
                ),
                tag: `t3code-approval:${tagSuffix}`,
                url: "/",
              })
              .pipe(Effect.catch(() => Effect.void));
          }

          if (activity.kind === "user-input.requested") {
            const requestId =
              (activity.payload as { requestId?: unknown } | undefined)?.requestId;
            const tagSuffix = typeof requestId === "string" ? requestId : threadId;
            return push
              .broadcast({
                title: "Question for you",
                body: shortPayloadLabel(
                  activity.payload,
                  "Agent is waiting on your answer.",
                ),
                tag: `t3code-question:${tagSuffix}`,
                url: "/",
              })
              .pipe(Effect.catch(() => Effect.void));
          }

          // ---- plan & per-task pushes (share the plan.updated event) ------
          if (activity.kind === "turn.plan.updated") {
            const dedupeKey = `${threadId}:${turnId}`;
            const effects: Effect.Effect<void, never>[] = [];

            // First time we see a plan for this turn (with pending work) —
            // push "Plan ready" once so the user can hop in for approval.
            if (
              !announcedPlanReady.has(dedupeKey) &&
              planHasPendingSteps(activity.payload)
            ) {
              announcedPlanReady.add(dedupeKey);
              effects.push(
                push
                  .broadcast({
                    title: "Plan ready",
                    body: shortPayloadLabel(
                      activity.payload,
                      "Tap to review the agent's plan.",
                    ),
                    tag: `t3code-plan-ready:${dedupeKey}`,
                    url: "/",
                  })
                  .pipe(Effect.catch(() => Effect.void)),
              );
            }

            // Per-task: announce each newly-completed plan step exactly once.
            const completed = completedPlanSteps(activity.payload);
            if (completed.length > 0) {
              let seen = notifiedSteps.get(dedupeKey);
              if (!seen) {
                seen = new Set();
                notifiedSteps.set(dedupeKey, seen);
              }
              const newlyDone = completed.filter((step) => !seen.has(step));
              for (const step of newlyDone) {
                seen.add(step);
              }
              for (const step of newlyDone) {
                effects.push(
                  push
                    .broadcast({
                      title: "Task completed",
                      body: step,
                      tag: `t3code-task:${step.slice(0, 60)}`,
                      url: "/",
                    })
                    .pipe(Effect.catch(() => Effect.void)),
                );
              }
            }

            if (effects.length === 0) return Effect.void;
            return Effect.all(effects, { concurrency: "unbounded", discard: true });
          }
        }

        return Effect.void;
      }),
    );
  });

  return { start } satisfies PushNotificationReactorShape;
});

export const PushNotificationReactorLive = Layer.effect(PushNotificationReactor, make);
