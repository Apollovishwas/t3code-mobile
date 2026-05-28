import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner } from "../../processRunner.ts";
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
import { buildThreadTranscriptDir } from "../transcriptSlice.ts";

/**
 * WikiWriter — spawn `almanac` subcommands against a project's
 * workspace root. Always passes `--no-auto-update` so we never trigger
 * Almanac's background `npm i -g` self-update (a notable source of
 * hangs and a security boundary breach in CI).
 *
 * Never installs Almanac's launchd automation: we have our own
 * AutomationScheduler. See `apps/server/src/wiki/Layers/WikiScheduler.ts`
 * for the scheduled-sweep equivalent.
 */

const DEFAULT_TIMEOUT = Duration.minutes(5);

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
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

  const runAlmanac = (
    cwd: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<WikiWriteResult, WikiReadFailure> =>
    runner
      .run({
        command: "almanac",
        args: ["--no-auto-update", ...args],
        cwd,
        timeout: DEFAULT_TIMEOUT,
        outputMode: "truncate",
        maxOutputBytes: 1 * 1024 * 1024,
        truncatedMarker: "\n[…output truncated by T3…]\n",
      })
      .pipe(
        Effect.map(
          (result): WikiWriteResult => ({
            command: "almanac",
            args: ["--no-auto-update", ...args],
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.code,
            timedOutMs: result.timedOut ? Duration.toMillis(DEFAULT_TIMEOUT) : null,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.fail(
            new WikiReadError({
              operation: `almanac ${args.join(" ")}`,
              detail: String(cause),
              cause,
            }),
          ),
        ),
      );

  const init: WikiWriterShape["init"] = ({ projectId }) =>
    Effect.gen(function* () {
      const cwd = yield* resolveWorkspaceRoot(projectId);
      return yield* runAlmanac(cwd, ["init"]);
    });

  const captureFromThread: WikiWriterShape["captureFromThread"] = ({ projectId, threadId }) =>
    Effect.gen(function* () {
      const cwd = yield* resolveWorkspaceRoot(projectId);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const slice = yield* buildThreadTranscriptDir({ projectId, threadId }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ProjectionSnapshotQuery, snapshot),
          );
          if (slice.messageCount === 0) {
            return {
              command: "almanac",
              args: ["ingest"],
              stdout: "",
              stderr: "no messages to absorb",
              exitCode: 0,
              timedOutMs: null,
            } satisfies WikiWriteResult;
          }
          return yield* runAlmanac(cwd, ["ingest", slice.path]);
        }),
      );
    });

  const garden: WikiWriterShape["garden"] = ({ projectId }) =>
    Effect.gen(function* () {
      const cwd = yield* resolveWorkspaceRoot(projectId);
      return yield* runAlmanac(cwd, ["garden"]);
    });

  const healthRun: WikiWriterShape["healthRun"] = ({ projectId }) =>
    Effect.gen(function* () {
      const cwd = yield* resolveWorkspaceRoot(projectId);
      return yield* runAlmanac(cwd, ["health"]);
    });

  return { init, captureFromThread, garden, healthRun } satisfies WikiWriterShape;
});

export const WikiWriterLive = Layer.effect(WikiWriter, make);
