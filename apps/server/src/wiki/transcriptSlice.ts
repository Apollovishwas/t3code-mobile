/**
 * Render a thread's conversation into a temp directory of markdown
 * files that Almanac's `ingest` command can absorb. We bypass
 * Almanac's transcript-discovery (which assumes `~/.claude/projects/`)
 * because T3 owns the projection and can produce a cleaner artifact.
 *
 * The temp dir lives under the configured state dir's `wiki/` namespace
 * so it shares the state-dir backup lifecycle. Scope-bound: cleanup on
 * close.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type { ProjectId, ThreadId } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WikiReadError, toWikiReadError } from "./Errors.ts";

export interface ThreadTranscriptDir {
  /** Directory holding `transcript.md` and any sidecar context files. */
  readonly path: string;
  /** Number of messages rendered. Useful for the writer to skip empty captures. */
  readonly messageCount: number;
}

/**
 * Build a single-file transcript directory for one thread.
 *
 * The returned dir contains exactly one `transcript.md` that lists
 * the thread's messages in chronological order. Almanac's `ingest`
 * walks the folder and absorbs the markdown into pages.
 */
export const buildThreadTranscriptDir = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}): Effect.Effect<
  ThreadTranscriptDir,
  WikiReadError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshot = yield* ProjectionSnapshotQuery;
    const detail = yield* snapshot
      .getThreadDetailById(input.threadId)
      .pipe(Effect.mapError(toWikiReadError(`getThreadDetailById:${input.threadId}`)));

    const dir = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-wiki-ingest-" })
      .pipe(Effect.orDie);

    // The OrchestrationThread shape isn't fully typed here — different
    // T3 builds carry different message structures. We dump a header
    // plus a best-effort serialisation of whatever message bodies are
    // present. Almanac's AI absorb pass copes with rough markdown.
    const header = [
      `# Thread transcript`,
      ``,
      `- thread: ${input.threadId}`,
      `- project: ${input.projectId}`,
      ``,
      `---`,
      ``,
    ].join("\n");

    let body = "";
    let messageCount = 0;
    const detailUnknown = detail as unknown as {
      messages?: ReadonlyArray<{
        readonly id?: string;
        readonly role?: string;
        readonly content?: string;
        readonly text?: string;
        readonly body?: string;
        readonly createdAt?: number;
      }>;
    };
    const maybeMessages = detailUnknown?.messages;
    if (Array.isArray(maybeMessages)) {
      for (const message of maybeMessages) {
        const role = message.role ?? "unknown";
        const text =
          message.content ?? message.text ?? message.body ?? "";
        if (!text.trim()) continue;
        body += `## ${role}\n\n${text.trim()}\n\n`;
        messageCount += 1;
      }
    }

    const target = path.join(dir, "transcript.md");
    yield* fs.writeFileString(target, header + body).pipe(Effect.orDie);
    return { path: dir, messageCount } satisfies ThreadTranscriptDir;
  });
