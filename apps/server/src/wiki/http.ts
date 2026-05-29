import { ProjectId, WikiPageSlug, WikiTopicSlug } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { WikiReader } from "./Services/WikiReader.ts";
import { WikiWriter } from "./Services/WikiWriter.ts";
import { WikiScheduler } from "./Services/WikiScheduler.ts";
import { detectAlmanac } from "./detect.ts";
import { writeWikiMarkdownForProject } from "./wikiMarkdown.ts";
import { ThreadId } from "@t3tools/contracts";

/**
 * HTTP API for the Wiki (Almanac integration). Read-only RPCs powering
 * the per-project Wiki UI; mutations live elsewhere (slice 4 — writer
 * spawns the `almanac` CLI as a subprocess).
 *
 * Auth model: same as Kanban — these are localhost / Tailscale-only.
 * The Wiki reader opens `<workspaceRoot>/.almanac/index.db` readonly
 * and never observes secrets from the agent's transcripts.
 *
 * Surface:
 *   - GET /api/wiki/status?projectId=…
 *   - GET /api/wiki/list?projectId=…[&topic=…&archival=active|archived|all&limit=…]
 *   - GET /api/wiki/page?projectId=…&slug=…
 *   - GET /api/wiki/search?projectId=…&q=…[&limit=…]
 *   - GET /api/wiki/topics?projectId=…
 *   - GET /api/wiki/health?projectId=…
 */

class WikiHttpError extends Schema.TaggedErrorClass<WikiHttpError>()("WikiHttpError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const respondToError = (error: WikiHttpError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }),
  );

const readProjectId = (
  url: URL,
): Effect.Effect<ProjectId, WikiHttpError> => {
  const raw = url.searchParams.get("projectId");
  if (!raw) {
    return Effect.fail(
      new WikiHttpError({ status: 400, message: "Missing required query parameter: projectId" }),
    );
  }
  return Effect.succeed(raw as ProjectId);
};

/** Map any WikiReadFailure to an HTTP response code. */
const failureStatus = (cause: unknown): number => {
  if (typeof cause !== "object" || cause === null) return 500;
  const tag = (cause as { _tag?: string })._tag;
  if (tag === "WikiNotInitializedError") return 404;
  if (tag === "WikiSchemaUnsupportedError") return 409;
  if (tag === "WikiProjectNotFoundError") return 404;
  return 500;
};

const liftRead = <A, E>(effect: Effect.Effect<A, E, WikiReader>, op: string) =>
  effect.pipe(
    Effect.mapError(
      (cause: E) =>
        new WikiHttpError({
          status: failureStatus(cause),
          message: `${op}: ${String((cause as { message?: string })?.message ?? cause)}`,
        }),
    ),
  );

// ---------------------------------------------------------------------------
// GET /api/wiki/status
// ---------------------------------------------------------------------------

export const wikiStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/status",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const reader = yield* WikiReader;
    const status = yield* liftRead(reader.getStatus(projectId), "getStatus");
    return HttpServerResponse.jsonUnsafe({ status }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/list
// ---------------------------------------------------------------------------

export const wikiListRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/list",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const topic = url.searchParams.get("topic") ?? undefined;
    const archivalRaw = url.searchParams.get("archival");
    const archival =
      archivalRaw === "all" || archivalRaw === "archived" || archivalRaw === "active"
        ? archivalRaw
        : undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const reader = yield* WikiReader;
    const pages = yield* liftRead(
      reader.listPages({ projectId, topic, archival, limit }),
      "listPages",
    );
    return HttpServerResponse.jsonUnsafe({ pages }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/page
// ---------------------------------------------------------------------------

export const wikiPageRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/page",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const slug = url.searchParams.get("slug");
    if (!slug) {
      return yield* new WikiHttpError({ status: 400, message: "Missing query parameter: slug" });
    }
    const reader = yield* WikiReader;
    const page = yield* liftRead(reader.getPage({ projectId, slug }), "getPage");
    return Option.match(page, {
      onNone: () =>
        HttpServerResponse.jsonUnsafe({ error: `No page: ${slug}` }, { status: 404 }),
      onSome: (p) => HttpServerResponse.jsonUnsafe({ page: p }, { status: 200 }),
    });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/search
// ---------------------------------------------------------------------------

export const wikiSearchRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/search",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      return HttpServerResponse.jsonUnsafe({ hits: [] }, { status: 200 });
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const reader = yield* WikiReader;
    const hits = yield* liftRead(
      reader.searchPages({ projectId, query, limit }),
      "searchPages",
    );
    return HttpServerResponse.jsonUnsafe({ hits }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/topics
// ---------------------------------------------------------------------------

export const wikiTopicsRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/topics",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const reader = yield* WikiReader;
    const tree = yield* liftRead(reader.getTopicTree({ projectId }), "getTopicTree");
    return HttpServerResponse.jsonUnsafe({ topics: tree }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/health
// ---------------------------------------------------------------------------

export const wikiHealthRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/health",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const reader = yield* WikiReader;
    const health = yield* liftRead(reader.getHealth({ projectId }), "getHealth");
    return HttpServerResponse.jsonUnsafe({ health }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/wiki/init { projectId } — runs `almanac init` in the project root.
// ---------------------------------------------------------------------------

const InitBody = Schema.Struct({ projectId: Schema.String });

export const wikiInitRouteLayer = HttpRouter.add(
  "POST",
  "/api/wiki/init",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(InitBody).pipe(
      Effect.mapError(
        (cause) =>
          new WikiHttpError({ status: 400, message: `Invalid body: ${String(cause)}` }),
      ),
    );
    const writer = yield* WikiWriter;
    const result = yield* writer
      .init({ projectId: input.projectId as ProjectId })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WikiHttpError({
              status: failureStatus(cause),
              message: `init: ${String((cause as { message?: string })?.message ?? cause)}`,
            }),
        ),
      );
    return HttpServerResponse.jsonUnsafe({ result }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/wiki/capture-thread { projectId, threadId } — ingest a thread.
// ---------------------------------------------------------------------------

const CaptureBody = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.String,
});

export const wikiCaptureThreadRouteLayer = HttpRouter.add(
  "POST",
  "/api/wiki/capture-thread",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(CaptureBody).pipe(
      Effect.mapError(
        (cause) =>
          new WikiHttpError({ status: 400, message: `Invalid body: ${String(cause)}` }),
      ),
    );
    const writer = yield* WikiWriter;
    const result = yield* writer
      .captureFromThread({
        projectId: input.projectId as ProjectId,
        threadId: ThreadId.make(input.threadId),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WikiHttpError({
              status: failureStatus(cause),
              message: `capture: ${String((cause as { message?: string })?.message ?? cause)}`,
            }),
        ),
      );
    return HttpServerResponse.jsonUnsafe({ result }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/wiki/garden { projectId } — consolidate/dedupe pages.
// ---------------------------------------------------------------------------

const GardenBody = Schema.Struct({ projectId: Schema.String });

export const wikiGardenRouteLayer = HttpRouter.add(
  "POST",
  "/api/wiki/garden",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(GardenBody).pipe(
      Effect.mapError(
        (cause) =>
          new WikiHttpError({ status: 400, message: `Invalid body: ${String(cause)}` }),
      ),
    );
    const writer = yield* WikiWriter;
    const result = yield* writer
      .garden({ projectId: input.projectId as ProjectId })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WikiHttpError({
              status: failureStatus(cause),
              message: `garden: ${String((cause as { message?: string })?.message ?? cause)}`,
            }),
        ),
      );
    return HttpServerResponse.jsonUnsafe({ result }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/detect — probe for the local `almanac` CLI install.
// Sliced out of /status because it has no projectId dependency and
// should be cheap enough to call from the install panel without
// triggering full DB opens.
// ---------------------------------------------------------------------------

export const wikiDetectRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/detect",
  Effect.gen(function* () {
    const result = yield* detectAlmanac();
    return HttpServerResponse.jsonUnsafe({ almanac: result }, { status: 200 });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/wiki/sweep { projectId } — fire a one-time sweep right now.
// Bypasses the interval clock and the hot-thread quiet window. Works
// whether or not a schedule exists for the project. This is the "Sync
// now" button.
// ---------------------------------------------------------------------------

const SweepBody = Schema.Struct({ projectId: Schema.String });

export const wikiSweepRouteLayer = HttpRouter.add(
  "POST",
  "/api/wiki/sweep",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(SweepBody).pipe(
      Effect.mapError(
        (cause) =>
          new WikiHttpError({ status: 400, message: `Invalid body: ${String(cause)}` }),
      ),
    );
    const scheduler = yield* WikiScheduler;
    const outcome = yield* scheduler.runOnce(input.projectId as ProjectId);
    return HttpServerResponse.jsonUnsafe({ outcome }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/wiki/schedules — list all in-memory schedules.
// ---------------------------------------------------------------------------

export const wikiSchedulesListRouteLayer = HttpRouter.add(
  "GET",
  "/api/wiki/schedules",
  Effect.gen(function* () {
    const scheduler = yield* WikiScheduler;
    const schedules = yield* scheduler.list();
    return HttpServerResponse.jsonUnsafe({ schedules }, { status: 200 });
  }),
);

// ---------------------------------------------------------------------------
// PUT /api/wiki/schedules { projectId, enabled, intervalMinutes }
// ---------------------------------------------------------------------------

const UpsertScheduleBody = Schema.Struct({
  projectId: Schema.String,
  enabled: Schema.Boolean,
  intervalMinutes: Schema.Number,
});

export const wikiSchedulesUpsertRouteLayer = HttpRouter.add(
  "PUT",
  "/api/wiki/schedules",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(UpsertScheduleBody).pipe(
      Effect.mapError(
        (cause) =>
          new WikiHttpError({ status: 400, message: `Invalid body: ${String(cause)}` }),
      ),
    );
    const scheduler = yield* WikiScheduler;
    const schedule = yield* scheduler.upsert({
      projectId: input.projectId as ProjectId,
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes,
    });
    return HttpServerResponse.jsonUnsafe({ schedule }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// DELETE /api/wiki/schedules?projectId=…
// ---------------------------------------------------------------------------

export const wikiSchedulesDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/wiki/schedules",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectId = yield* readProjectId(url);
    const scheduler = yield* WikiScheduler;
    yield* scheduler.remove(projectId);
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/wiki/export-md { projectId } — snapshot wiki to .t3/wiki.md.
// ---------------------------------------------------------------------------

const ExportBody = Schema.Struct({ projectId: Schema.String });

export const wikiExportMarkdownRouteLayer = HttpRouter.add(
  "POST",
  "/api/wiki/export-md",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(ExportBody).pipe(
      Effect.mapError(
        (cause) =>
          new WikiHttpError({ status: 400, message: `Invalid body: ${String(cause)}` }),
      ),
    );
    yield* writeWikiMarkdownForProject(input.projectId as ProjectId);
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(Effect.catchTag("WikiHttpError", respondToError)),
);

// Reference WikiPageSlug / WikiTopicSlug so the imports aren't tree-shaken
// — they're loadbearing for the contracts package import chain.
void WikiPageSlug;
void WikiTopicSlug;
