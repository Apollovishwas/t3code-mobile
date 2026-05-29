import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WikiProjectNotFoundError,
  WikiReadError,
  toWikiReadError,
  type WikiReadFailure,
} from "../Errors.ts";
import {
  WikiWriter,
  type WikiWriteResult,
  type WikiWriterShape,
} from "../Services/WikiWriter.ts";

/**
 * DIY wiki writer.
 *
 * No external CLI is spawned anywhere. `init` scaffolds the `.t3/wiki/`
 * folder with a starter `index.md`. `captureFromThread` / `garden` are
 * intentionally no-ops on the server side — the wiki is maintained
 * **by the interactive Claude Code session** chatting in the thread,
 * using the user's existing subscription. The HTTP endpoints stay
 * around so the UI buttons (the existing "Garden now" / "Capture into
 * wiki" controls in Settings) can return a friendly hint and surface
 * the slash-command path instead.
 *
 * Why this matters: the previous Almanac-based writer spawned the
 * `codealmanac` CLI which, after Anthropic's 2026-06-15 billing
 * change, will charge the Agent SDK credit pool ($20–$200/mo) rather
 * than the user's Claude Code subscription. Re-routing through the
 * interactive session keeps every operation on the subscription bucket.
 */

const STARTER_INDEX_MARKDOWN = `---
title: Wiki index
summary: Auto-generated landing page. Edit me through Claude in any thread.
topics: [wiki-meta]
updated_at: 0
archived: false
---

# Project wiki

This is the project's living wiki. Pages live here as one markdown file
per concept, with YAML frontmatter.

## How to add or update pages

Ask Claude in any thread:

- *"Write a wiki page about how the checkout flow works."*
- *"Update the auth wiki page — note that we now rotate tokens every 15m."*
- *"What does the wiki say about Stripe?"* — Claude will read pages from \`.t3/wiki/\`.

T3 will tell Claude where the wiki lives and what shape pages should be
in. You never need to edit these files by hand.

## Page format

\`\`\`markdown
---
title: <human-readable title>
summary: <one-line description>
topics: [topic-slug, another-topic]
file_refs:
  - src/some/path.ts
updated_at: <epoch ms — Claude sets this>
archived: false
---

<page body — markdown, with [[wikilinks]] to other pages>
\`\`\`
`;

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

  const okResult = (
    args: ReadonlyArray<string>,
    stdout: string,
  ): WikiWriteResult => ({
    command: "t3.wiki",
    args,
    stdout,
    stderr: "",
    exitCode: 0,
    timedOutMs: null,
  });

  const init: WikiWriterShape["init"] = ({ projectId }) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolveWorkspaceRoot(projectId);
      const wikiDir = wikiDirFor(workspaceRoot);
      yield* fs
        .makeDirectory(wikiDir, { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WikiReadError({
                operation: `init:makeDirectory:${wikiDir}`,
                detail: String(cause),
                cause,
              }),
          ),
        );
      const indexPath = path.join(wikiDir, "index.md");
      const indexExists = yield* fs
        .exists(indexPath)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!indexExists) {
        const nowMs = yield* Clock.currentTimeMillis;
        const content = STARTER_INDEX_MARKDOWN.replace(
          "updated_at: 0",
          `updated_at: ${nowMs}`,
        );
        yield* fs
          .writeFileString(indexPath, content)
          .pipe(
            Effect.mapError(
              (cause) =>
                new WikiReadError({
                  operation: `init:writeFile:${indexPath}`,
                  detail: String(cause),
                  cause,
                }),
            ),
          );
      }
      return okResult(["init", wikiDir], `Initialised wiki at ${wikiDir}`);
    });

  /**
   * Surface a friendly message — actual capture work happens by the
   * user typing `/wiki:learn` (or the equivalent) in the chat. The
   * scheduler can fire this to invite a thread to update its wiki.
   */
  const captureFromThread: WikiWriterShape["captureFromThread"] = ({ projectId, threadId }) =>
    Effect.gen(function* () {
      yield* resolveWorkspaceRoot(projectId); // validate project exists
      const stdout =
        `Capture is now driven by the chat. Open thread ${threadId} and type ` +
        `\`/wiki:learn\` to ask Claude to update relevant pages from the current session.`;
      return okResult(["capture-thread", String(threadId)], stdout);
    });

  /** Garden is now a chat-driven action; no API/billing cost on the server. */
  const garden: WikiWriterShape["garden"] = ({ projectId }) =>
    Effect.gen(function* () {
      yield* resolveWorkspaceRoot(projectId);
      const stdout =
        "Garden is now chat-driven. Open any thread in this project and ask " +
        "Claude `/wiki:lint` to consolidate, dedupe, or archive stale pages.";
      return okResult(["garden"], stdout);
    });

  /** Health is computed from the filesystem on read — no work to do here. */
  const healthRun: WikiWriterShape["healthRun"] = ({ projectId }) =>
    Effect.gen(function* () {
      yield* resolveWorkspaceRoot(projectId);
      return okResult(["health"], "Health is computed live by WikiReader.getHealth.");
    });

  return { init, captureFromThread, garden, healthRun } satisfies WikiWriterShape;
});

export const WikiWriterLive = Layer.effect(WikiWriter, make);
