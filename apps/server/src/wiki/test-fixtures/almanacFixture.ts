/**
 * Build a synthetic `.almanac/index.db` matching Almanac's schema
 * version 3 (8 tables + 1 FTS5 vtable). Used by WikiReader tests so
 * we don't need an actual `codealmanac` install in CI.
 *
 * The fixture is Effect-scoped: lifetime is bound to the test's
 * `Scope`, the temp dir is wiped on scope close. No manual cleanup.
 *
 * Note: we use INTEGER ms columns for `updated_at` / `archived_at`.
 * The reader's `toEpochMs` coercion also accepts ISO 8601 TEXT, but
 * INTEGER is cheaper to seed and what most native-sqlite consumers
 * default to.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { DatabaseSync } from "node:sqlite";

export interface FixturePageSpec {
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly body: string;
  readonly topics?: ReadonlyArray<string>;
  readonly fileRefs?: ReadonlyArray<{ path: string; isDir?: boolean }>;
  readonly outgoingLinks?: ReadonlyArray<string>;
  /** Required — tests pass a deterministic epoch ms so we avoid
   *  `Date.now()` and stale-window flakes. */
  readonly updatedAtMs: number;
  readonly archivedAtMs?: number | null;
  readonly supersededBy?: string | null;
}

export interface FixtureTopicSpec {
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly parent?: string | null;
}

export interface FixtureSpec {
  readonly pages: ReadonlyArray<FixturePageSpec>;
  readonly topics: ReadonlyArray<FixtureTopicSpec>;
  /** When omitted, the fixture omits the meta table — exercises the
   *  "table-presence fallback" probe in WikiReader. */
  readonly schemaVersion?: number | undefined;
}

export interface BuiltAlmanacFixture {
  /** Absolute path to the synthesised workspace root. */
  readonly workspaceRoot: string;
  /** Absolute path to the synthesised `.almanac/index.db`. */
  readonly dbPath: string;
}

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT,
    file_path TEXT NOT NULL,
    content_hash TEXT,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    superseded_by TEXT
  );
  CREATE TABLE IF NOT EXISTS topics (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT
  );
  CREATE TABLE IF NOT EXISTS page_topics (
    page_slug TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    topic_slug TEXT NOT NULL,
    PRIMARY KEY (page_slug, topic_slug)
  );
  CREATE TABLE IF NOT EXISTS topic_parents (
    child_slug TEXT NOT NULL,
    parent_slug TEXT NOT NULL,
    PRIMARY KEY (child_slug, parent_slug),
    CHECK (child_slug != parent_slug)
  );
  CREATE TABLE IF NOT EXISTS file_refs (
    page_slug TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    path TEXT NOT NULL,
    original_path TEXT,
    is_dir INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page_slug, path)
  );
  CREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);
  CREATE TABLE IF NOT EXISTS wikilinks (
    source_slug TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    target_slug TEXT NOT NULL,
    PRIMARY KEY (source_slug, target_slug)
  );
  CREATE TABLE IF NOT EXISTS cross_wiki_links (
    source_slug TEXT NOT NULL REFERENCES pages(slug) ON DELETE CASCADE,
    target_wiki TEXT NOT NULL,
    target_slug TEXT NOT NULL,
    PRIMARY KEY (source_slug, target_wiki, target_slug)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_pages USING fts5(slug, title, content);
`;

function seed(dbPath: string, spec: FixtureSpec): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_DDL);

    if (spec.schemaVersion !== undefined) {
      const insMeta = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
      insMeta.run("schema_version", String(spec.schemaVersion));
    }

    const insTopic = db.prepare(`INSERT INTO topics (slug, title, description) VALUES (?, ?, ?)`);
    const insTopicParent = db.prepare(
      `INSERT INTO topic_parents (child_slug, parent_slug) VALUES (?, ?)`,
    );
    for (const t of spec.topics) {
      insTopic.run(t.slug, t.title, t.description ?? null);
      if (t.parent) insTopicParent.run(t.slug, t.parent);
    }

    const insPage = db.prepare(
      `INSERT INTO pages (slug, title, summary, file_path, content_hash, updated_at, archived_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insPageTopic = db.prepare(
      `INSERT INTO page_topics (page_slug, topic_slug) VALUES (?, ?)`,
    );
    const insFileRef = db.prepare(
      `INSERT INTO file_refs (page_slug, path, original_path, is_dir) VALUES (?, ?, ?, ?)`,
    );
    const insWikilink = db.prepare(
      `INSERT INTO wikilinks (source_slug, target_slug) VALUES (?, ?)`,
    );
    const insFts = db.prepare(`INSERT INTO fts_pages (slug, title, content) VALUES (?, ?, ?)`);

    for (const p of spec.pages) {
      insPage.run(
        p.slug,
        p.title,
        p.summary ?? null,
        `pages/${p.slug}.md`,
        null,
        p.updatedAtMs,
        p.archivedAtMs ?? null,
        p.supersededBy ?? null,
      );
      for (const topic of p.topics ?? []) insPageTopic.run(p.slug, topic);
      for (const ref of p.fileRefs ?? [])
        insFileRef.run(p.slug, ref.path, ref.path, ref.isDir ? 1 : 0);
      for (const target of p.outgoingLinks ?? []) insWikilink.run(p.slug, target);
      insFts.run(p.slug, p.title, p.body);
    }
  } finally {
    db.close();
  }
}

export const buildAlmanacFixture = (
  spec: FixtureSpec,
): Effect.Effect<
  BuiltAlmanacFixture,
  never,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-wiki-fixture-" })
      .pipe(Effect.orDie);
    const almanacDir = path.join(workspaceRoot, ".almanac");
    yield* fs.makeDirectory(almanacDir, { recursive: true }).pipe(Effect.orDie);
    const dbPath = path.join(almanacDir, "index.db");
    yield* Effect.sync(() => seed(dbPath, spec));
    return { workspaceRoot, dbPath };
  });
