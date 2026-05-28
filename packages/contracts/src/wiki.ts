/**
 * Per-project Wiki contract.
 *
 * Reads `<projectRoot>/.almanac/index.db` — a SQLite cache that the
 * `codealmanac` CLI maintains alongside markdown pages in
 * `<projectRoot>/.almanac/pages/`. The DB schema (Almanac version 3,
 * 8 tables + 1 FTS5 vtable) is documented at
 * https://github.com/AlmanacCode/codealmanac.
 *
 * The Wiki UI in T3 is **read-only** — every page write happens through
 * the `almanac` CLI subprocess (`capture`, `garden`, `ingest`). The user
 * never edits a page in T3 directly; they chat with Claude or wait for
 * a scheduled sweep.
 *
 * Identity boundary: pages are keyed by `slug` (kebab-cased filename)
 * within a `(projectId, slug)` pair. We never invent ids — Almanac owns
 * the namespace.
 */

import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

// -------------------------------------------------------------------------
// Ids (kebab-cased filename stems, owned by Almanac)
// -------------------------------------------------------------------------

export const WikiPageSlug = Schema.String.pipe(Schema.brand("WikiPageSlug"));
export type WikiPageSlug = typeof WikiPageSlug.Type;

export const WikiTopicSlug = Schema.String.pipe(Schema.brand("WikiTopicSlug"));
export type WikiTopicSlug = typeof WikiTopicSlug.Type;

// -------------------------------------------------------------------------
// Page summary (list / search result row)
// -------------------------------------------------------------------------

export const WikiPageSummary = Schema.Struct({
  slug: WikiPageSlug,
  title: Schema.String,
  /** One-line summary from page frontmatter. May be empty string. */
  summary: Schema.String,
  /** Relative path under `.almanac/pages/`. */
  filePath: Schema.String,
  /** Topics this page is tagged with. */
  topics: Schema.Array(WikiTopicSlug),
  /** Last-touched timestamp in epoch ms. */
  updatedAt: Schema.Number,
  /** Null unless the page was archived. */
  archivedAt: Schema.NullOr(Schema.Number),
  /** Slug of a page that supersedes this one, if any. */
  supersededBy: Schema.NullOr(WikiPageSlug),
});
export type WikiPageSummary = typeof WikiPageSummary.Type;

// -------------------------------------------------------------------------
// Page detail (page + backlinks + file refs)
// -------------------------------------------------------------------------

export const WikiPage = Schema.Struct({
  ...WikiPageSummary.fields,
  /** Raw markdown body — frontmatter already stripped. */
  body: Schema.String,
  /** Pages this page links out to via `[[slug]]` syntax. */
  outgoingLinks: Schema.Array(WikiPageSlug),
  /** Pages that link IN to this page. */
  backlinks: Schema.Array(WikiPageSummary),
  /** File paths the page declares in frontmatter. */
  fileRefs: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      isDir: Schema.Boolean,
    }),
  ),
  /** Cross-wiki links: `[[wikiname:slug]]`. */
  crossWikiLinks: Schema.Array(
    Schema.Struct({
      wiki: Schema.String,
      slug: WikiPageSlug,
    }),
  ),
});
export type WikiPage = typeof WikiPage.Type;

// -------------------------------------------------------------------------
// Topic tree (DAG flattened to nested children)
// -------------------------------------------------------------------------

export const WikiTopic = Schema.Struct({
  slug: WikiTopicSlug,
  title: Schema.String,
  description: Schema.String,
  pageCount: Schema.Number,
});
export type WikiTopic = typeof WikiTopic.Type;

/**
 * One topic with its direct children resolved inline. Cycles are
 * impossible by table constraint (`CHECK child_slug != parent_slug`)
 * but we still cap depth at 8 defensively when materialising.
 *
 * Surfaced as a TS interface (not a Schema.Struct) because Schema
 * recursion through brand types is awkward; the reader returns
 * already-shaped objects so the wire-side decoder is unused.
 */
export interface WikiTopicTreeNode {
  readonly slug: WikiTopicSlug;
  readonly title: string;
  readonly description: string;
  readonly pageCount: number;
  readonly children: ReadonlyArray<WikiTopicTreeNode>;
}

// -------------------------------------------------------------------------
// Health snapshot (cheap counters powering the sidebar badge)
// -------------------------------------------------------------------------

export const WikiHealth = Schema.Struct({
  pageCount: Schema.Number,
  topicCount: Schema.Number,
  /** Pages with no topics. */
  orphanCount: Schema.Number,
  /** Pages older than the configured staleness threshold. */
  staleCount: Schema.Number,
  /** Pages with `archived_at` set. */
  archivedCount: Schema.Number,
  /** Wikilinks pointing to a slug that does not exist. */
  brokenLinkCount: Schema.Number,
  /** Schema version reported by Almanac (we require 3). */
  schemaVersion: Schema.Number,
});
export type WikiHealth = typeof WikiHealth.Type;

// -------------------------------------------------------------------------
// Inputs for read RPCs
// -------------------------------------------------------------------------

/**
 * Filter the page list. All fields are AND-combined. Null filter
 * fields are ignored.
 */
export const WikiListFilter = Schema.Struct({
  projectId: ProjectId,
  /** Filter by a single topic — pages tagged with this topic. */
  topic: Schema.optionalKey(WikiTopicSlug),
  /** "all" (default) | "active" | "archived". */
  archival: Schema.optionalKey(Schema.Literals(["all", "active", "archived"])),
  /** Cap returned pages. Defaults to 100. */
  limit: Schema.optionalKey(Schema.Number),
});
export type WikiListFilter = typeof WikiListFilter.Type;

export const WikiGetPageInput = Schema.Struct({
  projectId: ProjectId,
  slug: WikiPageSlug,
});
export type WikiGetPageInput = typeof WikiGetPageInput.Type;

export const WikiSearchInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.String,
  /** Limit to this many hits. Defaults to 30. */
  limit: Schema.optionalKey(Schema.Number),
});
export type WikiSearchInput = typeof WikiSearchInput.Type;

export const WikiGetTopicTreeInput = Schema.Struct({
  projectId: ProjectId,
});
export type WikiGetTopicTreeInput = typeof WikiGetTopicTreeInput.Type;

export const WikiHealthInput = Schema.Struct({
  projectId: ProjectId,
});
export type WikiHealthInput = typeof WikiHealthInput.Type;

// -------------------------------------------------------------------------
// Status surface — distinguishes "no .almanac/" from "schema too new"
// from "happy"
// -------------------------------------------------------------------------

export const WikiStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("not-initialized"),
    /** Resolved workspace root we looked under. */
    workspaceRoot: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("unsupported-schema"),
    /** Schema version we found on disk (we require 3). */
    schemaVersion: Schema.Number,
    workspaceRoot: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    workspaceRoot: Schema.String,
    /** Mirror of WikiHealth without a fresh sweep. */
    health: WikiHealth,
  }),
]);
export type WikiStatus = typeof WikiStatus.Type;
