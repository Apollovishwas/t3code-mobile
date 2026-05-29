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

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WikiNotInitializedError,
  WikiProjectNotFoundError,
  WikiReadError,
  toWikiReadError,
  type WikiReadFailure,
} from "../Errors.ts";
import { parsePage, slugFromFilename, type ParsedPage } from "../markdownParse.ts";
import { WikiReader, type WikiReaderShape } from "../Services/WikiReader.ts";

/**
 * DIY wiki reader — backs the `/wiki` UI by walking `.t3/wiki/*.md`
 * inside each project's workspace root. Pages are plain markdown with
 * YAML frontmatter; the agent (interactive Claude Code session) is
 * the only thing that writes them. No external CLI, no SQLite, no API
 * key — the running thread does all the editing using the user's
 * existing Claude subscription.
 *
 * See `.t3/wiki/` page format in `markdownParse.ts`.
 *
 * Status mapping:
 *   - `.t3/wiki/` missing or empty → "not-initialized"
 *   - schema version is unused for this format; `schemaVersion` is
 *     reported as 1 for compatibility with the old contract.
 */

const STALE_THRESHOLD_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const T3_WIKI_FORMAT_VERSION = 1;

/** Threshold under which a `.t3/wiki/` counts as "initialized". */
const MIN_PAGES_FOR_INITIALIZED = 0; // folder existing is enough — Claude may not have written yet

function pageToSummary(page: ParsedPage): WikiPageSummary {
  return {
    slug: WikiPageSlug.make(page.slug),
    title: page.title,
    summary: page.summary,
    filePath: `.t3/wiki/${page.slug}.md`,
    topics: page.topics.map((t) => WikiTopicSlug.make(t)),
    updatedAt: page.updatedAt,
    archivedAt: page.archived ? page.updatedAt : null,
    supersededBy: page.supersededBy ? WikiPageSlug.make(page.supersededBy) : null,
  };
}

const make = Effect.gen(function* () {
  const snapshot = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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

  const wikiDirFor = (workspaceRoot: string) => path.join(workspaceRoot, ".t3", "wiki");

  /** List `.md` files in the wiki dir (top-level only). Hidden / underscore-
   *  prefixed names are ignored — those are reserved for T3-managed
   *  artifacts (e.g. `_skeleton.md`, `_topics.md`). */
  const listPageFiles = (wikiDir: string) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(wikiDir).pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) return [] as ReadonlyArray<string>;
      const entries = yield* fs
        .readDirectory(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)));
      return entries.filter(
        (entry) => entry.endsWith(".md") && !entry.startsWith("_") && !entry.startsWith("."),
      );
    });

  const readAllPages = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const wikiDir = wikiDirFor(workspaceRoot);
      const files = yield* listPageFiles(wikiDir);
      if (files.length === 0) return [] as ReadonlyArray<ParsedPage>;
      const pages = yield* Effect.forEach(
        files,
        (filename) =>
          Effect.gen(function* () {
            if (slugFromFilename(filename) === null) return null;
            const filePath = path.join(wikiDir, filename);
            const stat = yield* fs.stat(filePath).pipe(
              Effect.catchCause(() => Effect.succeed(null as unknown as { mtime: Option.Option<Date> })),
            );
            const mtimeMs =
              stat && Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0;
            const content = yield* fs
              .readFileString(filePath)
              .pipe(Effect.catchCause(() => Effect.succeed("")));
            return parsePage(filename, content, mtimeMs);
          }),
        { concurrency: 8 },
      );
      return pages.filter((p): p is ParsedPage => p !== null);
    });

  const computeHealth = (
    pages: ReadonlyArray<ParsedPage>,
    nowMs: number,
  ): WikiHealth => {
    const slugSet = new Set(pages.map((p) => p.slug));
    const knownTopics = new Set<string>();
    let orphan = 0;
    let stale = 0;
    let archived = 0;
    let broken = 0;
    const staleCutoff = nowMs - STALE_THRESHOLD_MS;
    for (const page of pages) {
      for (const topic of page.topics) knownTopics.add(topic);
      if (page.topics.length === 0) orphan += 1;
      if (page.archived) archived += 1;
      if (!page.archived && page.updatedAt > 0 && page.updatedAt < staleCutoff) stale += 1;
      for (const target of page.outgoingLinks) {
        if (!slugSet.has(target)) broken += 1;
      }
    }
    return {
      pageCount: pages.length,
      topicCount: knownTopics.size,
      orphanCount: orphan,
      staleCount: stale,
      archivedCount: archived,
      brokenLinkCount: broken,
      schemaVersion: T3_WIKI_FORMAT_VERSION,
    };
  };

  const getStatus: WikiReaderShape["getStatus"] = (projectId) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      const exists = yield* fs
        .exists(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return { state: "not-initialized", workspaceRoot } satisfies WikiStatus;
      }
      const pages = yield* readAllPages(workspaceRoot);
      if (pages.length < MIN_PAGES_FOR_INITIALIZED) {
        return { state: "not-initialized", workspaceRoot } satisfies WikiStatus;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const health = computeHealth(pages, nowMs);
      return { state: "ready", workspaceRoot, health } satisfies WikiStatus;
    });

  const listPages: WikiReaderShape["listPages"] = (input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      const exists = yield* fs
        .exists(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return yield* new WikiNotInitializedError({ workspaceRoot });
      }
      const pages = yield* readAllPages(workspaceRoot);
      const archival = input.archival ?? "active";
      const limit = Math.max(1, Math.min(500, input.limit ?? 100));
      let filtered = pages;
      if (archival === "active") filtered = filtered.filter((p) => !p.archived);
      else if (archival === "archived") filtered = filtered.filter((p) => p.archived);
      if (input.topic) {
        const t = input.topic;
        filtered = filtered.filter((p) => p.topics.includes(t));
      }
      filtered = [...filtered].sort((a, b) => {
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
        return a.slug.localeCompare(b.slug);
      });
      return filtered.slice(0, limit).map(pageToSummary);
    });

  const getPage: WikiReaderShape["getPage"] = (input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      const exists = yield* fs
        .exists(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return yield* new WikiNotInitializedError({ workspaceRoot });
      }
      const pages = yield* readAllPages(workspaceRoot);
      const page = pages.find((p) => p.slug === input.slug);
      if (!page) return Option.none<WikiPage>();

      const backlinks = pages
        .filter((other) => other.slug !== page.slug && other.outgoingLinks.includes(page.slug))
        .map(pageToSummary);

      const wikiPage: WikiPage = {
        ...pageToSummary(page),
        body: page.body,
        outgoingLinks: page.outgoingLinks.map((s) => WikiPageSlug.make(s)),
        backlinks,
        fileRefs: page.fileRefs,
        crossWikiLinks: page.crossWikiLinks.map((c) => ({
          wiki: c.wiki,
          slug: WikiPageSlug.make(c.slug),
        })),
      };
      return Option.some(wikiPage);
    });

  /** Plain substring search across title/summary/body. Case-insensitive. */
  const searchPages: WikiReaderShape["searchPages"] = (input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      const exists = yield* fs
        .exists(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return yield* new WikiNotInitializedError({ workspaceRoot });
      }
      const needle = input.query.trim().toLowerCase();
      if (needle.length === 0) return [];
      const pages = yield* readAllPages(workspaceRoot);
      const limit = Math.max(1, Math.min(200, input.limit ?? 30));
      const hits = pages
        .map((p) => {
          const hay = `${p.title}\n${p.summary}\n${p.body}`.toLowerCase();
          const idx = hay.indexOf(needle);
          return idx === -1 ? null : { page: p, score: idx };
        })
        .filter((r): r is { page: ParsedPage; score: number } => r !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map(({ page }) => pageToSummary(page));
      return hits;
    });

  const getTopicTree: WikiReaderShape["getTopicTree"] = (input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      const exists = yield* fs
        .exists(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return yield* new WikiNotInitializedError({ workspaceRoot });
      }
      const pages = yield* readAllPages(workspaceRoot);
      const counts = new Map<string, number>();
      for (const page of pages) {
        if (page.archived) continue;
        for (const topic of page.topics) {
          counts.set(topic, (counts.get(topic) ?? 0) + 1);
        }
      }
      const nodes: WikiTopicTreeNode[] = Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([slug, count]) => ({
          slug: WikiTopicSlug.make(slug),
          title: slug,
          description: "",
          pageCount: count,
          children: [],
        }));
      return nodes;
    });

  const getHealth: WikiReaderShape["getHealth"] = (input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(input.projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      const exists = yield* fs
        .exists(wikiDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        return yield* new WikiNotInitializedError({ workspaceRoot });
      }
      const pages = yield* readAllPages(workspaceRoot);
      const nowMs = yield* Clock.currentTimeMillis;
      return computeHealth(pages, nowMs);
    });

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

// `WikiReadError` import is kept reachable so future error mapping in this
// module won't break if the import path is reorganised.
void WikiReadError;
