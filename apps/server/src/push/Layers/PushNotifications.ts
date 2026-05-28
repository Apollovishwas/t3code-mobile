import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import webpush from "web-push";

import { ServerConfig } from "../../config.ts";
import {
  PushNotifications,
  type PushNotificationsShape,
  type StoredSubscription,
} from "../Services/PushNotifications.ts";

// web-push requires a `mailto:` or `https:` subject identifying the sender.
const VAPID_SUBJECT = "mailto:notifications@t3code.local";

const VapidKeysSchema = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});

const StoredSubscriptionSchema = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }),
});
const SubscriptionsSchema = Schema.Array(StoredSubscriptionSchema);

const PushPayloadSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const decodeVapidKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(VapidKeysSchema));
const encodeVapidKeys = Schema.encodeEffect(Schema.fromJsonString(VapidKeysSchema));
const decodeSubscriptions = Schema.decodeUnknownEffect(Schema.fromJsonString(SubscriptionsSchema));
const encodeSubscriptions = Schema.encodeEffect(Schema.fromJsonString(SubscriptionsSchema));
const encodePushPayload = Schema.encodeEffect(Schema.fromJsonString(PushPayloadSchema));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Private key lives with other secrets; the subscription list is not secret.
  const vapidPath = path.join(config.secretsDir, "push-vapid.json");
  const subscriptionsPath = path.join(config.stateDir, "push-subscriptions.json");

  // Load the VAPID keypair, generating and persisting one on first run.
  const existingKeys = yield* fs
    .readFileString(vapidPath)
    .pipe(Effect.flatMap(decodeVapidKeys), Effect.option);

  const keys = yield* Option.match(existingKeys, {
    onSome: (value) => Effect.succeed(value),
    onNone: () =>
      Effect.gen(function* () {
        const generated = yield* Effect.sync(() => webpush.generateVAPIDKeys());
        const record = { publicKey: generated.publicKey, privateKey: generated.privateKey };
        yield* Effect.gen(function* () {
          const contents = yield* encodeVapidKeys(record);
          yield* fs.makeDirectory(path.dirname(vapidPath), { recursive: true }).pipe(Effect.ignore);
          yield* fs.writeFileString(vapidPath, contents);
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("failed to persist VAPID keys", { cause })),
        );
        return record;
      }),
  });

  yield* Effect.sync(() => webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey));

  // Restore persisted subscriptions (empty on first run or parse failure).
  const persisted = yield* fs.readFileString(subscriptionsPath).pipe(
    Effect.flatMap(decodeSubscriptions),
    Effect.orElseSucceed(() => [] as ReadonlyArray<StoredSubscription>),
  );
  const subscriptionsRef = yield* Ref.make(
    new Map<string, StoredSubscription>(persisted.map((sub) => [sub.endpoint, sub] as const)),
  );

  const persist = Effect.gen(function* () {
    const map = yield* Ref.get(subscriptionsRef);
    const contents = yield* encodeSubscriptions([...map.values()]);
    yield* fs
      .makeDirectory(path.dirname(subscriptionsPath), { recursive: true })
      .pipe(Effect.ignore);
    yield* fs.writeFileString(subscriptionsPath, contents);
  }).pipe(Effect.catch((cause) => Effect.logWarning("failed to persist subscriptions", { cause })));

  yield* Effect.logInfo("push notifications ready", {
    publicKeyPrefix: keys.publicKey.slice(0, 12),
  });

  return {
    publicKey: Effect.succeed(keys.publicKey),

    subscribe: (subscription) =>
      Effect.gen(function* () {
        yield* Ref.update(subscriptionsRef, (map) =>
          new Map(map).set(subscription.endpoint, subscription),
        );
        yield* persist;
      }),

    unsubscribe: (endpoint) =>
      Effect.gen(function* () {
        yield* Ref.update(subscriptionsRef, (map) => {
          const next = new Map(map);
          next.delete(endpoint);
          return next;
        });
        yield* persist;
      }),

    broadcast: (payload) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(subscriptionsRef);
        if (map.size === 0) {
          return;
        }
        const body = yield* encodePushPayload(payload).pipe(Effect.orDie);
        const stale: string[] = [];
        yield* Effect.forEach(
          [...map.values()],
          (subscription) =>
            Effect.promise(() =>
              webpush
                .sendNotification(
                  { endpoint: subscription.endpoint, keys: subscription.keys },
                  body,
                )
                .then(() => null)
                .catch((error: { statusCode?: number }) => error),
            ).pipe(
              Effect.tap((result) =>
                // 404/410 mean the subscription is permanently gone — prune it.
                result && (result.statusCode === 404 || result.statusCode === 410)
                  ? Effect.sync(() => {
                      stale.push(subscription.endpoint);
                    })
                  : Effect.void,
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
        if (stale.length > 0) {
          yield* Ref.update(subscriptionsRef, (current) => {
            const next = new Map(current);
            for (const endpoint of stale) next.delete(endpoint);
            return next;
          });
          yield* persist;
        }
      }),
  } satisfies PushNotificationsShape;
});

export const PushNotificationsLive = Layer.effect(PushNotifications, make);
