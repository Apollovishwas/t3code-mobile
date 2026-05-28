/**
 * HTTP routes for discovering existing Claude Code sessions, powering the
 * "resume a Claude session" thread-creation wizard.
 *
 * - GET /api/claude-sessions/folders        → folders that have Claude history
 * - GET /api/claude-sessions?cwd=<folder>   → recent sessions for a folder
 *
 * Both are owner/authenticated and read-only (they expose local session
 * history, so they must not be reachable unauthenticated).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerAuth } from "./../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import * as Schema from "effect/Schema";

import {
  deleteClaudeSession,
  listClaudeSessionFolders,
  listClaudeSessionsForCwd,
} from "./discovery.ts";

const DeleteSessionInput = Schema.Struct({ sessionId: Schema.String });

const requireAuthenticated = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

export const claudeSessionFoldersRouteLayer = HttpRouter.add(
  "GET",
  "/api/claude-sessions/folders",
  Effect.gen(function* () {
    yield* requireAuthenticated;
    const folders = yield* listClaudeSessionFolders;
    return HttpServerResponse.jsonUnsafe(
      { folders },
      { status: 200, headers: browserApiCorsHeaders },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const claudeSessionsRouteLayer = HttpRouter.add(
  "GET",
  "/api/claude-sessions",
  Effect.gen(function* () {
    yield* requireAuthenticated;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Bad Request" },
        { status: 400, headers: browserApiCorsHeaders },
      );
    }
    const cwd = url.value.searchParams.get("cwd");
    if (!cwd) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Missing cwd parameter" },
        { status: 400, headers: browserApiCorsHeaders },
      );
    }
    const limitParam = url.value.searchParams.get("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const sessions = yield* listClaudeSessionsForCwd(
      cwd,
      limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    );
    return HttpServerResponse.jsonUnsafe(
      { sessions },
      { status: 200, headers: browserApiCorsHeaders },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const claudeSessionDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/claude-sessions/delete",
  Effect.gen(function* () {
    yield* requireAuthenticated;
    const { sessionId } = yield* HttpServerRequest.schemaBodyJson(DeleteSessionInput);
    const deleted = yield* deleteClaudeSession(sessionId);
    return HttpServerResponse.jsonUnsafe(
      { deleted },
      { status: 200, headers: browserApiCorsHeaders },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
