import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { browserApiCorsHeaders } from "../httpCors.ts";
import { PushNotifications } from "./Services/PushNotifications.ts";

const SubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
});

const UnsubscribeInput = Schema.Struct({
  endpoint: Schema.String,
});

const badRequest = (label: string) => (cause: unknown) =>
  Effect.as(
    Effect.logWarning(`push route failed: ${label}`, { cause }),
    HttpServerResponse.jsonUnsafe({ ok: false }, { status: 400, headers: browserApiCorsHeaders }),
  );

export const pushPublicKeyRouteLayer = HttpRouter.add(
  "GET",
  "/api/push/public-key",
  Effect.gen(function* () {
    const push = yield* PushNotifications;
    const publicKey = yield* push.publicKey;
    return HttpServerResponse.jsonUnsafe(
      { publicKey },
      { status: 200, headers: browserApiCorsHeaders },
    );
  }),
);

export const pushSubscribeRouteLayer = HttpRouter.add(
  "POST",
  "/api/push/subscribe",
  Effect.gen(function* () {
    const push = yield* PushNotifications;
    const subscription = yield* HttpServerRequest.schemaBodyJson(SubscriptionInput);
    yield* push.subscribe(subscription);
    return HttpServerResponse.jsonUnsafe(
      { ok: true },
      { status: 200, headers: browserApiCorsHeaders },
    );
  }).pipe(Effect.catch(badRequest("subscribe"))),
);

export const pushUnsubscribeRouteLayer = HttpRouter.add(
  "POST",
  "/api/push/unsubscribe",
  Effect.gen(function* () {
    const push = yield* PushNotifications;
    const { endpoint } = yield* HttpServerRequest.schemaBodyJson(UnsubscribeInput);
    yield* push.unsubscribe(endpoint);
    return HttpServerResponse.jsonUnsafe(
      { ok: true },
      { status: 200, headers: browserApiCorsHeaders },
    );
  }).pipe(Effect.catch(badRequest("unsubscribe"))),
);
