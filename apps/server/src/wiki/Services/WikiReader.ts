import type {
  ProjectId,
  WikiHealth,
  WikiPage,
  WikiPageSummary,
  WikiStatus,
  WikiTopicTreeNode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { WikiReadFailure } from "../Errors.ts";

/**
 * WikiReader — read-only view of a project's Almanac wiki.
 *
 * The service resolves `projectId → workspaceRoot` internally via the
 * projection's shell snapshot, then opens `<root>/.almanac/index.db`
 * for the duration of each call (node:sqlite, readonly, no WAL).
 * Reads are cheap; we deliberately do NOT cache the connection so
 * Almanac's own `garden` / `capture` writes never race with us.
 */

export interface WikiReaderShape {
  /** Cheap status probe — backs the sidebar entry, the install panel, and the health badge. */
  readonly getStatus: (
    projectId: ProjectId,
  ) => Effect.Effect<WikiStatus, WikiReadFailure>;

  readonly listPages: (input: {
    readonly projectId: ProjectId;
    readonly topic?: string | undefined;
    readonly archival?: "all" | "active" | "archived" | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<WikiPageSummary>, WikiReadFailure>;

  readonly getPage: (input: {
    readonly projectId: ProjectId;
    readonly slug: string;
  }) => Effect.Effect<Option.Option<WikiPage>, WikiReadFailure>;

  readonly searchPages: (input: {
    readonly projectId: ProjectId;
    readonly query: string;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<WikiPageSummary>, WikiReadFailure>;

  /** Roots of the topic DAG — children resolved inline. */
  readonly getTopicTree: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<ReadonlyArray<WikiTopicTreeNode>, WikiReadFailure>;

  readonly getHealth: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<WikiHealth, WikiReadFailure>;
}

export class WikiReader extends Context.Service<WikiReader, WikiReaderShape>()(
  "t3/wiki/WikiReader",
) {}
