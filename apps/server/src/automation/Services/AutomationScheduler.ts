import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Long-lived service that ticks the AutomationRepository every N seconds,
 * dispatches due automations through the orchestration engine, and
 * records the outcome (success / failure) into the run-history table.
 *
 * Modelled after `ProviderSessionReaper` — `start()` forks a scoped
 * fiber that drives the sweep loop until the layer's scope closes on
 * server shutdown.
 */
export interface AutomationSchedulerShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Manual "run now" hook. The RPC layer calls this when the user taps
   * the per-automation "Run now" button so we don't have to wait for
   * the next sweep. Returns the outcome so the UI can display it.
   */
  readonly runNow: (input: {
    readonly id: string;
  }) => Effect.Effect<{ readonly outcome: "fired" | "failed"; readonly detail: string | null }, never>;
}

export class AutomationScheduler extends Context.Service<
  AutomationScheduler,
  AutomationSchedulerShape
>()("t3/automation/Services/AutomationScheduler/AutomationScheduler") {}
