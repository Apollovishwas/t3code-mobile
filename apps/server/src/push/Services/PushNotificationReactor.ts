/**
 * PushNotificationReactor - sends a Web Push when an agent turn finishes.
 *
 * Subscribes to orchestration domain events and broadcasts a notification to
 * every registered push subscription on turn completion. This is the only
 * mechanism that reaches a backgrounded/suspended iOS PWA (where foreground JS
 * and the WebSocket are frozen).
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface PushNotificationReactorShape {
  /** Start the reactor. Must run in a scope so the worker fiber is finalized. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class PushNotificationReactor extends Context.Service<
  PushNotificationReactor,
  PushNotificationReactorShape
>()("t3/push/Services/PushNotificationReactor") {}
