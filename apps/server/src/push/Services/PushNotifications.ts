/**
 * PushNotifications - Web Push service interface.
 *
 * Owns the VAPID keypair and the set of browser push subscriptions (persisted
 * as JSON under the server data dir) and sends notifications via `web-push`.
 * Shared by the HTTP routes and the push reactor.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface StoredSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface PushPayload {
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
  readonly url?: string;
}

export interface PushNotificationsShape {
  /** VAPID public key the browser uses to create a subscription. */
  readonly publicKey: Effect.Effect<string>;
  readonly subscribe: (subscription: StoredSubscription) => Effect.Effect<void>;
  readonly unsubscribe: (endpoint: string) => Effect.Effect<void>;
  /** Sends a notification to every stored subscription. */
  readonly broadcast: (payload: PushPayload) => Effect.Effect<void>;
}

export class PushNotifications extends Context.Service<PushNotifications, PushNotificationsShape>()(
  "t3/push/Services/PushNotifications",
) {}
