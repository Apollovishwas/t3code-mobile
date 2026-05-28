import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { WikiReadFailure } from "../Errors.ts";

/**
 * Result of a write operation — exit code + truncated stdout/stderr.
 * The Wiki UI displays this verbatim in a "last run" details panel.
 */
export interface WikiWriteResult {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOutMs: number | null;
}

export interface WikiWriterShape {
  /** `almanac init` in the project's workspace root. */
  readonly init: (
    input: { readonly projectId: ProjectId },
  ) => Effect.Effect<WikiWriteResult, WikiReadFailure>;

  /** Render thread → tempdir → `almanac ingest`. Dodges Almanac's
   *  hardcoded ~/.claude/projects/ transcript discovery. */
  readonly captureFromThread: (
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
  ) => Effect.Effect<WikiWriteResult, WikiReadFailure>;

  /** `almanac garden` — consolidate / dedupe / archive stale pages. */
  readonly garden: (
    input: { readonly projectId: ProjectId },
  ) => Effect.Effect<WikiWriteResult, WikiReadFailure>;

  /** `almanac health` — diagnostic JSON for the badge. */
  readonly healthRun: (
    input: { readonly projectId: ProjectId },
  ) => Effect.Effect<WikiWriteResult, WikiReadFailure>;
}

export class WikiWriter extends Context.Service<WikiWriter, WikiWriterShape>()(
  "t3/wiki/WikiWriter",
) {}
