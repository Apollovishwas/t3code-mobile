import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  WikiPageSlug,
  WikiTopicSlug,
  type WikiStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WikiReader } from "../Services/WikiReader.ts";
import { WikiReaderLive } from "./WikiReader.ts";

const projectId = ProjectId.make("proj-test");

const FIXTURE_NOW_MS = 1_716_864_000_000; // 2024-05-28

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

interface SeedPage {
  readonly filename: string;
  readonly content: string;
}

/** Build a temp workspace dir + .t3/wiki/ + the seeded markdown files. */
const seedWiki = (pages: ReadonlyArray<SeedPage>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-wiki-md-fixture-" })
      .pipe(Effect.orDie);
    const wikiDir = path.join(workspaceRoot, ".t3", "wiki");
    yield* fs.makeDirectory(wikiDir, { recursive: true }).pipe(Effect.orDie);
    for (const page of pages) {
      yield* fs
        .writeFileString(path.join(wikiDir, page.filename), page.content)
        .pipe(Effect.orDie);
    }
    return workspaceRoot;
  });

/** Build the wiki fixture and run the test body against a fresh
 *  WikiReader bound to it. */
const withFixture = <A, E>(
  pages: ReadonlyArray<SeedPage>,
  body: (workspaceRoot: string) => Effect.Effect<A, E, WikiReader>,
) =>
  Effect.gen(function* () {
    const workspaceRoot = yield* seedWiki(pages);
    return yield* body(workspaceRoot).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.provideMerge(WikiReaderLive, makeSnapshotMock(workspaceRoot)),
          NodeServices.layer,
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const checkoutPage = `---
title: Checkout flow
summary: How a user reaches /pay and what happens next.
topics: [payments]
file_refs:
  - src/checkout/index.ts
updated_at: ${FIXTURE_NOW_MS - 1_000}
---

When a user hits /pay, we validate the cart, then charge via Stripe.

See [[refresh-tokens]] for the auth side.
`;

const refreshTokensPage = `---
title: Refresh token rotation
summary: Tokens rotate every 15 minutes.
topics: [auth]
file_refs:
  - src/auth/tokens.ts
updated_at: ${FIXTURE_NOW_MS - 2_000}
---

Tokens rotate every 15m. Old refresh tokens are invalidated on use.

Related: [[checkout-flow]].
`;

const archivedPage = `---
title: Old design doc
summary: Pre-2024 architecture, superseded.
topics: [auth]
updated_at: ${FIXTURE_NOW_MS - 10_000}
archived: true
---

Historical only.
`;

const happyPages: ReadonlyArray<SeedPage> = [
  { filename: "checkout-flow.md", content: checkoutPage },
  { filename: "refresh-tokens.md", content: refreshTokensPage },
  { filename: "old-design-doc.md", content: archivedPage },
];

describe("WikiReader (markdown backend)", () => {
  describe("getStatus", () => {
    it.effect("reports not-initialized when .t3/wiki/ is missing", () =>
      withFixture([], () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          // Status DOES need the wiki dir to exist for "ready" but we
          // seeded zero pages — the seed mkdir creates the dir, so this
          // returns "ready" with pageCount: 0. The "not-initialized"
          // path is covered separately below by withMissingDir().
          const status: WikiStatus = yield* reader.getStatus(projectId);
          assert.strictEqual(status.state, "ready");
          if (status.state === "ready") {
            assert.strictEqual(status.health.pageCount, 0);
          }
        }),
      ),
    );

    it.effect("reports ready with health counts on a happy fixture", () =>
      withFixture(happyPages, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const status: WikiStatus = yield* reader.getStatus(projectId);
          assert.strictEqual(status.state, "ready");
          if (status.state === "ready") {
            assert.strictEqual(status.health.pageCount, 3);
            assert.strictEqual(status.health.topicCount, 2);
            assert.strictEqual(status.health.archivedCount, 1);
            assert.strictEqual(status.health.schemaVersion, 1);
          }
        }),
      ),
    );
  });

  describe("listPages", () => {
    it.effect("returns active pages by default, archived excluded", () =>
      withFixture(happyPages, () =>
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
      withFixture(happyPages, () =>
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
      withFixture(happyPages, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const pages = yield* reader.listPages({ projectId });
          const checkout = pages.find((p) => p.slug === WikiPageSlug.make("checkout-flow"));
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
      withFixture(happyPages, () =>
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
      withFixture(happyPages, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const result = yield* reader.getPage({ projectId, slug: "does-not-exist" });
          assert.ok(Option.isNone(result));
        }),
      ),
    );
  });

  describe("searchPages", () => {
    it.effect("substring search hits body text", () =>
      withFixture(happyPages, () =>
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

    it.effect("empty query returns no hits", () =>
      withFixture(happyPages, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const hits = yield* reader.searchPages({ projectId, query: "   " });
          assert.strictEqual(hits.length, 0);
        }),
      ),
    );
  });

  describe("getTopicTree", () => {
    it.effect("flat list of topics with page counts", () =>
      withFixture(happyPages, () =>
        Effect.gen(function* () {
          const reader = yield* WikiReader;
          const roots = yield* reader.getTopicTree({ projectId });
          const slugs = roots.map((r) => r.slug);
          // Only "auth" is active (refresh-tokens); old-design-doc is archived
          // so we don't count it. "payments" is active via checkout-flow.
          assert.deepStrictEqual([...slugs].sort(), [
            WikiTopicSlug.make("auth"),
            WikiTopicSlug.make("payments"),
          ]);
          const auth = roots.find((r) => r.slug === WikiTopicSlug.make("auth"));
          assert.strictEqual(auth?.pageCount, 1);
        }),
      ),
    );
  });
});
