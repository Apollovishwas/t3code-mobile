import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  WikiPageSlug,
  WikiTopicSlug,
  type WikiStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildAlmanacFixture,
  type BuiltAlmanacFixture,
  type FixtureSpec,
} from "../test-fixtures/almanacFixture.ts";
import { WikiReader } from "../Services/WikiReader.ts";
import { WikiReaderLive } from "./WikiReader.ts";

const projectId = ProjectId.make("proj-test");

// Deterministic timestamp anchored well in the past — keeps `staleCount`
// behaviour predictable in tests that run weeks apart.
const FIXTURE_NOW_MS = 1_716_864_000_000; // 2024-05-28

/** Mock the projection so `projectId → workspaceRoot` resolution
 *  points at our synthesised fixture. */
function makeSnapshotMock(workspaceRoot: string) {
  return Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        projects: [
          {
            id: projectId,
            title: "Test project",
            workspaceRoot,
          },
        ],
      } as never),
  });
}

/** Build the fixture inside the test's scope, then run `body` against
 *  a fresh WikiReader bound to that fixture. */
const withFixture = <A, E>(
  spec: FixtureSpec,
  body: (fixture: BuiltAlmanacFixture) => Effect.Effect<A, E, WikiReader>,
) =>
  Effect.gen(function* () {
    const fixture = yield* buildAlmanacFixture(spec);
    return yield* body(fixture).pipe(
      Effect.provide(Layer.provideMerge(WikiReaderLive, makeSnapshotMock(fixture.workspaceRoot))),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const happySpec: FixtureSpec = {
  schemaVersion: 3,
  topics: [
    { slug: "auth", title: "Auth", description: "Authentication & identity" },
    { slug: "payments", title: "Payments", description: "Money in & out" },
    // Child topic so we exercise the DAG resolver.
    { slug: "sessions", title: "Sessions", description: "Login state", parent: "auth" },
  ],
  pages: [
    {
      slug: "checkout-flow",
      title: "Checkout flow",
      summary: "How a user reaches /pay and what happens next.",
      body: "When a user hits /pay, we validate the cart, then charge via Stripe.",
      topics: ["payments"],
      outgoingLinks: ["refresh-tokens"],
      fileRefs: [{ path: "src/checkout/index.ts" }],
      updatedAtMs: FIXTURE_NOW_MS - 1_000,
    },
    {
      slug: "refresh-tokens",
      title: "Refresh token rotation",
      summary: "Tokens rotate every 15 minutes.",
      body: "Tokens rotate every 15m. Old refresh tokens are invalidated on use.",
      topics: ["auth"],
      outgoingLinks: ["checkout-flow"],
      fileRefs: [{ path: "src/auth/tokens.ts" }],
      updatedAtMs: FIXTURE_NOW_MS - 2_000,
    },
    {
      slug: "old-design-doc",
      title: "Old design doc",
      summary: "Pre-2024 architecture, superseded.",
      body: "Historical only.",
      topics: ["auth"],
      updatedAtMs: FIXTURE_NOW_MS - 10_000,
      archivedAtMs: FIXTURE_NOW_MS - 10_000,
    },
  ],
};

describe("WikiReader", () => {
  describe("getStatus", () => {
    it.effect("reports not-initialized when .almanac is missing", () =>
      Effect.gen(function* () {
        const reader = yield* WikiReader;
        const status = yield* reader.getStatus(projectId);
        assert.strictEqual(status.state, "not-initialized");
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.provideMerge(WikiReaderLive, makeSnapshotMock("/tmp/does-not-exist")),
            NodeServices.layer,
          ),
        ),
      ),
    );

    it.effect("reports unsupported-schema when meta says v999", () =>
      withFixture(
        {
          pages: [],
          topics: [],
          schemaVersion: 999,
        },
        () =>
          Effect.gen(function* () {
            const reader = yield* WikiReader;
            const status = yield* reader.getStatus(projectId);
            assert.strictEqual(status.state, "unsupported-schema");
            if (status.state === "unsupported-schema") {
              assert.strictEqual(status.schemaVersion, 999);
            }
          }),
      ),
    );

    it.effect("reports ready with health counts on a happy fixture", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const status: WikiStatus = yield* reader.getStatus(projectId);
          assert.strictEqual(status.state, "ready");
          if (status.state === "ready") {
            assert.strictEqual(status.health.pageCount, 3);
            assert.strictEqual(status.health.topicCount, 3);
            assert.strictEqual(status.health.archivedCount, 1);
            assert.strictEqual(status.health.schemaVersion, 3);
          }
        }),
      ),
    );
  });

  describe("listPages", () => {
    it.effect("returns active pages by default, archived excluded", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const pages = yield* reader.listPages({ projectId });
          assert.strictEqual(pages.length, 2, "archived page should be excluded by default");
          assert.deepStrictEqual(
            pages.map((p) => p.slug),
            [WikiPageSlug.make("checkout-flow"), WikiPageSlug.make("refresh-tokens")],
            "ordered by updated_at desc",
          );
        }),
      ),
    );

    it.effect("filters by topic", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const pages = yield* reader.listPages({ projectId, topic: "auth" });
          assert.deepStrictEqual(
            pages.map((p) => p.slug),
            [WikiPageSlug.make("refresh-tokens")],
          );
        }),
      ),
    );

    it.effect("surfaces topics on each page summary", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const pages = yield* reader.listPages({ projectId });
          const checkout = pages.find(
            (p) => p.slug === (WikiPageSlug.make("checkout-flow") as WikiPageSlug),
          );
          assert.ok(checkout);
          assert.deepStrictEqual(
            [...(checkout?.topics ?? [])],
            [WikiTopicSlug.make("payments")],
          );
        }),
      ),
    );
  });

  describe("getPage", () => {
    it.effect("loads body + backlinks + file refs", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const result = yield* reader.getPage({ projectId, slug: "refresh-tokens" });
          assert.ok(Option.isSome(result), "expected page");
          if (Option.isSome(result)) {
            const page = result.value;
            assert.ok(page.body.includes("Tokens rotate"));
            assert.deepStrictEqual(
              [...page.outgoingLinks],
              [WikiPageSlug.make("checkout-flow")],
            );
            assert.deepStrictEqual(
              page.backlinks.map((b) => b.slug),
              [WikiPageSlug.make("checkout-flow")],
            );
            assert.deepStrictEqual(
              [...page.fileRefs],
              [{ path: "src/auth/tokens.ts", isDir: false }],
            );
          }
        }),
      ),
    );

    it.effect("returns None on missing slug", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const result = yield* reader.getPage({ projectId, slug: "does-not-exist" });
          assert.ok(Option.isNone(result));
        }),
      ),
    );
  });

  describe("searchPages", () => {
    it.effect("FTS hits match a body word", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const hits = yield* reader.searchPages({ projectId, query: "rotate" });
          assert.deepStrictEqual(
            hits.map((h) => h.slug),
            [WikiPageSlug.make("refresh-tokens")],
          );
        }),
      ),
    );

    it.effect("escapes embedded quotes safely", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          // A bare " would break unquoted FTS; the reader wraps as phrase
          // and doubles internal quotes. The important property is "does
          // not throw"; FTS may still match the substring before the quote.
          const hits = yield* reader.searchPages({ projectId, query: `rotate"` });
          assert.ok(hits.length >= 0, "search did not throw on embedded quote");
        }),
      ),
    );
  });

  describe("getTopicTree", () => {
    it.effect("resolves children inline for the auth → sessions edge", () =>
      withFixture(happySpec, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const roots = yield* reader.getTopicTree({ projectId });
          const auth = roots.find((r) => r.slug === WikiTopicSlug.make("auth"));
          assert.ok(auth, "expected auth root topic");
          const childSlugs = auth!.children.map((c) => c.slug);
          assert.deepStrictEqual(childSlugs, [WikiTopicSlug.make("sessions")]);
        }),
      ),
    );
  });
});
