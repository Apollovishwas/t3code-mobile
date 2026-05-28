import { useEffect, useMemo, useRef, useState } from "react";
import type { Thread } from "~/types";

/**
 * Picks which sprite the working mascot should be playing right now based on
 * the agent's live activity stream. See `ComposerMascot.tsx` for the visual
 * side and `MASCOT_SPRITES` in `mascotSprites.ts` for per-action frame counts
 * and timings.
 *
 * The result has two flavours:
 *  - "loop" actions (Push, Walk, Run, Idle, Climb, Attack1, Throw) keep
 *    playing until the agent moves on to a different state.
 *  - "one-shot" actions (Jump, Hurt) overlay the loop for a short window
 *    when a triggering event fires, then revert. Jump fires on each new
 *    `task.completed` (debounced to once per turn-id+step combo). Hurt
 *    fires on each new `runtime.error`.
 */

export type MascotAction =
  | "push"
  | "walk"
  | "run"
  | "idle"
  | "climb"
  | "attack1"
  | "throw"
  | "jump"
  | "hurt";

interface UseMascotActionParams {
  /** Recent activity stream — same shape ChatComposer already receives. */
  readonly activities: Thread["activities"] | undefined;
  /** Non-null while an approval prompt is pending. */
  readonly hasPendingApproval: boolean;
  /** True while the agent is asking the user a question. */
  readonly hasPendingUserInput: boolean;
}

interface UseMascotActionResult {
  readonly action: MascotAction;
  /** True while a Jump/Hurt one-shot is active (caller may want to suppress walking). */
  readonly oneShot: boolean;
}

/** Map a tool's `payload.itemType` to a loop action. */
function actionForToolItem(itemType: string | undefined): MascotAction {
  switch (itemType) {
    case "command_execution":
      return "run";
    case "file_change":
      return "attack1";
    case "web_search":
      return "climb";
    case "collab_agent_tool_call":
      return "throw";
    // mcp_tool_call, dynamic_tool_call, image_view — generic working
    default:
      return "walk";
  }
}

/** How long each one-shot overlays the underlying loop, in ms. */
const JUMP_MS = 800;
const HURT_MS = 400;
/** Debounce so a rapid burst of identical events doesn't restart the one-shot. */
const ONE_SHOT_RETRIGGER_GUARD_MS = 200;

export function useMascotAction({
  activities,
  hasPendingApproval,
  hasPendingUserInput,
}: UseMascotActionParams): UseMascotActionResult {
  // -- Base loop action: derived synchronously from the latest activity. ----
  const baseAction = useMemo<MascotAction>(() => {
    if (hasPendingApproval || hasPendingUserInput) return "idle";
    if (!activities || activities.length === 0) return "idle";

    // Scan from the most recent activity backward, looking for something we
    // can map onto a sprite. Lots of activities are non-visual (e.g.,
    // checkpoint.captured, runtime.note) and shouldn't change the loop.
    for (let i = activities.length - 1; i >= 0; i--) {
      const act = activities[i];
      if (!act) continue;
      switch (act.kind) {
        case "tool.started":
        case "tool.updated": {
          const payload = act.payload as { itemType?: string } | undefined;
          return actionForToolItem(payload?.itemType);
        }
        case "tool.completed":
          // Between tools — give it a beat of idle until the next thing
          // starts. Looks like the agent is thinking.
          return "idle";
        case "context-compaction":
          return "climb";
        default:
          continue;
      }
    }
    return "idle";
  }, [activities, hasPendingApproval, hasPendingUserInput]);

  // -- One-shot overlays: track latest matching activity, debounce, expire. -
  const [oneShot, setOneShot] = useState<{
    action: "jump" | "hurt";
    expiresAt: number;
  } | null>(null);
  const lastTriggerRef = useRef<{ kind: string; activityId: string; at: number } | null>(null);

  useEffect(() => {
    if (!activities || activities.length === 0) return;
    // Look at just the tail — only the freshest task.completed / runtime.error
    // should ever trigger a fresh one-shot.
    const latest = activities[activities.length - 1];
    if (!latest) return;
    const trigger =
      latest.kind === "task.completed"
        ? { action: "jump" as const, durationMs: JUMP_MS }
        : latest.kind === "runtime.error"
          ? { action: "hurt" as const, durationMs: HURT_MS }
          : null;
    if (!trigger) return;

    const activityId = String(
      (latest as { id?: unknown }).id ?? `${latest.kind}@${activities.length}`,
    );
    const now = Date.now();
    const last = lastTriggerRef.current;
    // Same activity already triggered, or another trigger fired so recently
    // that we'd visually stutter — skip.
    if (last && last.activityId === activityId) return;
    if (last && last.kind === latest.kind && now - last.at < ONE_SHOT_RETRIGGER_GUARD_MS) {
      return;
    }

    lastTriggerRef.current = { kind: latest.kind, activityId, at: now };
    setOneShot({ action: trigger.action, expiresAt: now + trigger.durationMs });
  }, [activities]);

  // Expire the one-shot when its window closes.
  useEffect(() => {
    if (!oneShot) return;
    const remaining = oneShot.expiresAt - Date.now();
    if (remaining <= 0) {
      setOneShot(null);
      return;
    }
    const timer = window.setTimeout(() => setOneShot(null), remaining);
    return () => window.clearTimeout(timer);
  }, [oneShot]);

  if (oneShot) {
    return { action: oneShot.action, oneShot: true };
  }
  return { action: baseAction, oneShot: false };
}
