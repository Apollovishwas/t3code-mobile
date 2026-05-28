import {
  ProjectId,
  WikiHealth,
  WikiPage,
  WikiPageSlug,
  WikiPageSummary,
  WikiStatus,
  WikiTopicSlug,
} from "@t3tools/contracts";
import type { WikiTopicTreeNode } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { DatabaseSync } from "node:sqlite";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WikiNotInitializedError,
  WikiProjectNotFoundError,
  WikiReadError,
  WikiSchemaUnsupportedError,
  toWikiReadError,
  type WikiReadFailure,
} from "../Errors.ts";
import { WikiReader, type WikiReaderShape } from "../Services/WikiReader.ts";

/**
 * Almanac's hard-coded schema version (as of 2026-05). We refuse to
 * read DBs at any other version so the UI surfaces a clear "your
 * Almanac is newer than T3 knows about" message instead of garbled
 * rows from a renamed column.
 */
export const SUPPORTED_ALMANAC_SCHEMA_VERSION = 3;

/**
 * Staleness threshold for the health probe — pages untouched for this
 * long count as "stale". Matches Almanac's documented default of
 * ~6 months but cheaper to compute. Surfaced through `WikiHealth.staleCount`.
 */
const STALE_THRESHOLD_MS = 1000 * 60 * 60 * 24 * 90;

/**
 * Almanac stores its schema version in a `meta` table (since v3) with
 * row key 'schema_version'. We fall back to "presence of `pages` and
 * `fts_pages` tables means version 3" when meta is absent, since
 * pre-meta builds existed briefly.
 */
const SCHEMA_VERSION_PROBE_SQL = `
  SELECT value FROM meta WHERE key = 'schema_version'
  UNION ALL
  SELECT '3' WHERE EXISTS (
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pages'
  )
  LIMIT 1
`;

/** Acquire / release a readonly node:sqlite handle. */
function withDb<A, E extends WikiReadFailure>(
  dbPath: string,
  use: (db: DatabaseSync) => Effect.Effect<A, E>,
): Effect.Effect<A, E | WikiReadError> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => new DatabaseSync(dbPath, { readOnly: true }),
      catch: toWikiReadError(`open:${dbPath}`),
    }),
    use,
    (db) =>
      Effect.sync(() => {
        try {
          db.close();
        } catch {
          // closing a readonly handle on a missing file can throw; ignore.
        }
      }),
  );
}

/** Run a parameterised SELECT and return decoded rows. */
function selectAll<T>(
  db: DatabaseSync,
  sql: string,
  params: ReadonlyArray<string | number | null> = [],
  operation: string,
): Effect.Effect<ReadonlyArray<T>, WikiReadError> {
  return Effect.try({
    try: () => {
      const stmt = db.prepare(sql);
      return stmt.all(...params) as unknown as ReadonlyArray<T>;
    },
    catch: toWikiReadError(operation),
  });
}

interface PageRow {
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly file_path: string;
  readonly updated_at: unknown;
  readonly archived_at: unknown;
  readonly superseded_by: string | null;
}

interface PageBodyRow extends PageRow {
  readonly content: string | null;
}

interface TopicRow {
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly page_count: number;
}

interface TopicEdgeRow {
  readonly child_slug: string;
  readonly parent_slug: string | null;
}

interface PageTopicRow {
  readonly page_slug: string;
  readonly topic_slug: string;
}

interface WikilinkRow {
  readonly source_slug: string;
  readonly target_slug: string;
}

interface FileRefRow {
  readonly path: string;
  readonly is_dir: number;
}

interface CrossWikiRow {
  readonly target_wiki: string;
  readonly target_slug: string;
}

/**
 * SELECT columns for a page row. We deliberately do NOT cast
 * `updated_at` / `archived_at` here — Almanac's source repo doesn't
 * document the column type, and casting an INTEGER ms column through
 * `strftime` returns NULL. Instead we read whatever's there and parse
 * defensively in `toEpochMs` below; that handles INTEGER ms, INTEGER
 * seconds, and ISO 8601 TEXT identically.
 */
const PAGE_COLUMNS = `
  slug AS "slug",
  title AS "title",
  summary AS "summary",
  file_path AS "file_path",
  updated_at AS "updated_at",
  archived_at AS "archived_at",
  superseded_by AS "superseded_by"
`;

/** Best-effort epoch-ms coercion. Accepts JS number (ms), bigint, or
 *  ISO 8601 string. Returns 0 for null / unparseable. */
function toEpochMs(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    // Heuristic: < 10^12 = seconds, scale up.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function toEpochMsOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = toEpochMs(value);
  return n === 0 ? null : n;
}

function rowToSummary(
  row: PageRow,
  topicIndex: ReadonlyMap<string, ReadonlyArray<string>>,
): WikiPageSummary {
  return {
    slug: WikiPageSlug.make(row.slug),
    title: row.title,
    summary: row.summary ?? "",
    filePath: row.file_path,
    topics: (topicIndex.get(row.slug) ?? []).map((t) => WikiTopicSlug.make(t)),
    updatedAt: toEpochMs(row.updated_at),
    archivedAt: toEpochMsOrNull(row.archived_at),
    supersededBy: row.superseded_by ? WikiPageSlug.make(row.superseded_by) : null,
  };
}

/** Roll a flat (child, parent) edge list into trees rooted at every
 *  topic that has no parent. Caps depth at 8 for cycle safety even
 *  though the table CHECK enforces child!=parent. */
function buildTopicTree(
  topics: ReadonlyArray<TopicRow>,
  edges: ReadonlyArray<TopicEdgeRow>,
): ReadonlyArray<WikiTopicTreeNode> {
  const byParent = new Map<string, string[]>();
  const childSlugs = new Set<string>();
  for (const e of edges) {
    if (e.parent_slug === null) continue;
    if (!byParent.has(e.parent_slug)) byParent.set(e.parent_slug, []);
    byParent.get(e.parent_slug)!.push(e.child_slug);
    childSlugs.add(e.child_slug);
  }
  const topicMap = new Map(topics.map((t) => [t.slug, t]));

  const build = (slug: string, depth: number): WikiTopicTreeNode | null => {
    if (depth > 8) return null;
    const t = topicMap.get(slug);
    if (!t) return null;
    return {
      slug: WikiTopicSlug.make(t.slug),
      title: t.title,
      description: t.description ?? "",
      pageCount: t.page_count,
      children: (byParent.get(slug) ?? [])
        .map((child) => build(child, depth + 1))
        .filter((c): c is WikiTopicTreeNode => c !== null),
    };
  };

  return topics
    .filter((t) => !childSlugs.has(t.slug))
    .map((t) => build(t.slug, 0))
    .filter((n): n is WikiTopicTreeNode => n !== null);
}

/** Internal: probe `meta`/sqlite_master for schema version. */
function readSchemaVersion(db: DatabaseSync): number {
  try {
    const stmt = db.prepare(SCHEMA_VERSION_PROBE_SQL);
    const row = stmt.get() as { value: string } | undefined;
    if (!row) return 0;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const make = Effect.gen(function* () {
  const snapshot = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Resolve `projectId → workspaceRoot` via the projection's shell snapshot. */
  const resolveWorkspaceRoot = (
    projectId: ProjectId,
  ): Effect.Effect<string, WikiReadFailure> =>
    Effect.gen(function* () {
      const shell = yield* snapshot
        .getShellSnapshot()
        .pipe(Effect.mapError(toWikiReadError("ProjectionSnapshotQuery.getShellSnapshot")));
      const project = shell.projects.find((p) => p.id === projectId);
      if (!project) {
        return yield* new WikiProjectNotFoundError({ projectId });
      }
      return project.workspaceRoot;
    });

  const dbPathFor = (workspaceRoot: string) =>
    path.join(workspaceRoot, ".almanac", "index.db");

  const computeHealth = (
    db: DatabaseSync,
    schemaVersion: number,
  ): Effect.Effect<WikiHealth, WikiReadError> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const staleCutoffMs = nowMs - STALE_THRESHOLD_MS;
      const counts = yield* selectAll<{ key: string; n: number }>(
        db,
        `
          SELECT 'pages' AS "key", COUNT(*) AS "n" FROM pages
          UNION ALL
          SELECT 'topics', COUNT(*) FROM topics
          UNION ALL
          SELECT 'orphans', COUNT(*) FROM pages
            WHERE slug NOT IN (SELECT DISTINCT page_slug FROM page_topics)
          UNION ALL
          SELECT 'archived', COUNT(*) FROM pages WHERE archived_at IS NOT NULL
          UNION ALL
          SELECT 'stale', COUNT(*) FROM pages
            WHERE archived_at IS NULL
              AND (
                (TYPEOF(updated_at) = 'integer' AND updated_at < ?)
                OR (TYPEOF(updated_at) = 'text'
                    AND CAST(strftime('%s', updated_at) AS INTEGER) * 1000 < ?)
              )
          UNION ALL
          SELECT 'broken', COUNT(*) FROM wikilinks
            WHERE target_slug NOT IN (SELECT slug FROM pages)
        `,
        [staleCutoffMs, staleCutoffMs],
        "computeHealth",
      );
      const lookup = (key: string) => counts.find((r) => r.key === key)?.n ?? 0;
      return {
        pageCount: lookup("pages"),
        topicCount: lookup("topics"),
        orphanCount: lookup("orphans"),
        staleCount: lookup("stale"),
        archivedCount: lookup("archived"),
        brokenLinkCount: lookup("broken"),
        schemaVersion,
      };
    });

  /** Common: resolve root + check DB exists + open + check schema. */
  const withReadyDb = <A>(
    projectId: ProjectId,
    use: (db: DatabaseSync, workspaceRoot: string) => Effect.Effect<A, WikiReadFailure>,
  ): Effect.Effect<A, WikiReadFailure> =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(projectId);
      const dbPath = dbPathFor(workspaceRoot);
      const exists = yield* fs
        .exists(dbPath)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return yield* new WikiNotInitializedError({ workspaceRoot });
      }
      return yield* withDb(dbPath, (db) =>
        Effect.gen(function* () {
          const version = readSchemaVersion(db);
          if (version !== SUPPORTED_ALMANAC_SCHEMA_VERSION) {
            return yield* new WikiSchemaUnsupportedError({
              workspaceRoot,
              schemaVersion: version,
              supportedVersion: SUPPORTED_ALMANAC_SCHEMA_VERSION,
            });
          }
          return yield* use(db, workspaceRoot);
        }),
      );
    });

  const getStatus: WikiReaderShape["getStatus"] = (projectId) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(projectId);
      const dbPath = dbPathFor(workspaceRoot);
      const exists = yield* fs
        .exists(dbPath)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        const status: WikiStatus = { state: "not-initialized", workspaceRoot };
        return status;
      }
      return yield* withDb(dbPath, (db): Effect.Effect<WikiStatus, WikiReadError> =>
        Effect.gen(function* () {
          const version = readSchemaVersion(db);
          if (version !== SUPPORTED_ALMANAC_SCHEMA_VERSION) {
            const status: WikiStatus = {
              state: "unsupported-schema",
              schemaVersion: version,
              workspaceRoot,
            };
            return status;
          }
          const health = yield* computeHealth(db, version);
          const status: WikiStatus = { state: "ready", workspaceRoot, health };
          return status;
        }),
      );
    });

  /** Build the page-slug → topic-slug[] index once per call. */
  const loadTopicIndex = (db: DatabaseSync) =>
    selectAll<PageTopicRow>(
      db,
      `SELECT page_slug, topic_slug FROM page_topics ORDER BY page_slug, topic_slug`,
      [],
      "loadTopicIndex",
    ).pipe(
      Effect.map((rows) => {
        const index = new Map<string, string[]>();
        for (const row of rows) {
          if (!index.has(row.page_slug)) index.set(row.page_slug, []);
          index.get(row.page_slug)!.push(row.topic_slug);
        }
        return index as ReadonlyMap<string, ReadonlyArray<string>>;
      }),
    );

  const listPages: WikiReaderShape["listPages"] = (input) =>
    withReadyDb(input.projectId, (db) =>
      Effect.gen(function* () {
        const topicIndex = yield* loadTopicIndex(db);
        const limit = Math.max(1, Math.min(500, input.limit ?? 100));
        const archival = input.archival ?? "active";

        const archiveClause =
          archival === "all"
            ? ""
            : archival === "archived"
              ? "AND archived_at IS NOT NULL"
              : "AND archived_at IS NULL";

        const topicClause = input.topic
          ? `AND slug IN (SELECT page_slug FROM page_topics WHERE topic_slug = ?)`
          : "";

        const params: Array<string | number> = [];
        if (input.topic) params.push(input.topic);
        params.push(limit);

        const sql = `
          SELECT ${PAGE_COLUMNS}
          FROM pages
          WHERE 1=1 ${archiveClause} ${topicClause}
          ORDER BY COALESCE(updated_at, '') DESC, slug ASC
          LIMIT ?
        `;
        const rows = yield* selectAll<PageRow>(db, sql, params, "listPages");
        return rows.map((r) => rowToSummary(r, topicIndex));
      }),
    );

  const getPage: WikiReaderShape["getPage"] = (input) =>
    withReadyDb(input.projectId, (db) =>
      Effect.gen(function* () {
        const topicIndex = yield* loadTopicIndex(db);
        const rows = yield* selectAll<PageBodyRow>(
          db,
          `
            SELECT ${PAGE_COLUMNS},
              (SELECT content FROM fts_pages WHERE slug = pages.slug) AS "content"
            FROM pages
            WHERE slug = ?
            LIMIT 1
          `,
          [input.slug],
          "getPage:fetch",
        );
        const row = rows[0];
        if (!row) return Option.none<WikiPage>();

        const outgoing = yield* selectAll<WikilinkRow>(
          db,
          `SELECT source_slug, target_slug FROM wikilinks WHERE source_slug = ?`,
          [input.slug],
          "getPage:outgoing",
        );
        const incoming = yield* selectAll<WikilinkRow>(
          db,
          `SELECT source_slug, target_slug FROM wikilinks WHERE target_slug = ?`,
          [input.slug],
          "getPage:incoming",
        );
        const fileRefs = yield* selectAll<FileRefRow>(
          db,
          `SELECT path, is_dir FROM file_refs WHERE page_slug = ? ORDER BY path ASC`,
          [input.slug],
          "getPage:fileRefs",
        );
        const crossWiki = yield* selectAll<CrossWikiRow>(
          db,
          `SELECT target_wiki, target_slug FROM cross_wiki_links WHERE source_slug = ?`,
          [input.slug],
          "getPage:crossWiki",
        );

        const backlinkSlugs = incoming.map((r) => r.source_slug);
        const backlinkSummaries: ReadonlyArray<WikiPageSummary> =
          backlinkSlugs.length === 0
            ? []
            : yield* selectAll<PageRow>(
                db,
                `SELECT ${PAGE_COLUMNS} FROM pages WHERE slug IN (${backlinkSlugs.map(() => "?").join(", ")})`,
                backlinkSlugs,
                "getPage:backlinkSummaries",
              ).pipe(Effect.map((rs) => rs.map((r) => rowToSummary(r, topicIndex))));

        const summary = rowToSummary(row, topicIndex);
        const page: WikiPage = {
          ...summary,
          body: row.content ?? "",
          outgoingLinks: outgoing.map((r) => WikiPageSlug.make(r.target_slug)),
          backlinks: backlinkSummaries,
          fileRefs: fileRefs.map((r) => ({ path: r.path, isDir: r.is_dir !== 0 })),
          crossWikiLinks: crossWiki.map((r) => ({
            wiki: r.target_wiki,
            slug: WikiPageSlug.make(r.target_slug),
          })),
        };
        return Option.some(page);
      }),
    );

  const searchPages: WikiReaderShape["searchPages"] = (input) =>
    withReadyDb(input.projectId, (db) =>
      Effect.gen(function* () {
        const topicIndex = yield* loadTopicIndex(db);
        const limit = Math.max(1, Math.min(200, input.limit ?? 30));
        // FTS5 syntax allows phrase + prefix; users may not know that.
        // Wrap their raw query as a phrase so they can't accidentally
        // hit a syntax error with stray colons or quotes.
        const fts = `"${input.query.replace(/"/g, '""')}"`;
        const rows = yield* selectAll<PageRow>(
          db,
          `
            SELECT
              p.slug AS "slug",
              p.title AS "title",
              p.summary AS "summary",
              p.file_path AS "file_path",
              p.updated_at AS "updated_at",
              p.archived_at AS "archived_at",
              p.superseded_by AS "superseded_by"
            FROM pages p
            JOIN fts_pages f ON f.slug = p.slug
            WHERE fts_pages MATCH ?
            ORDER BY f.rank ASC, p.updated_at DESC
            LIMIT ?
          `,
          [fts, limit],
          "searchPages",
        );
        return rows.map((r) => rowToSummary(r, topicIndex));
      }),
    );

  const getTopicTree: WikiReaderShape["getTopicTree"] = (input) =>
    withReadyDb(input.projectId, (db) =>
      Effect.gen(function* () {
        const topics = yield* selectAll<TopicRow>(
          db,
          `
            SELECT
              t.slug AS "slug",
              t.title AS "title",
              t.description AS "description",
              COUNT(pt.page_slug) AS "page_count"
            FROM topics t
            LEFT JOIN page_topics pt ON pt.topic_slug = t.slug
            GROUP BY t.slug
            ORDER BY t.title ASC
          `,
          [],
          "getTopicTree:topics",
        );
        const edges = yield* selectAll<TopicEdgeRow>(
          db,
          `SELECT child_slug, parent_slug FROM topic_parents`,
          [],
          "getTopicTree:edges",
        );
        return buildTopicTree(topics, edges);
      }),
    );

  const getHealth: WikiReaderShape["getHealth"] = (input) =>
    withReadyDb(input.projectId, (db) =>
      Effect.gen(function* () {
        const version = readSchemaVersion(db);
        return yield* computeHealth(db, version);
      }),
    );

  return {
    getStatus,
    listPages,
    getPage,
    searchPages,
    getTopicTree,
    getHealth,
  } satisfies WikiReaderShape;
});

export const WikiReaderLive = Layer.effect(WikiReader, make);
