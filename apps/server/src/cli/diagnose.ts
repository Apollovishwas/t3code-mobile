import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/unstable/cli";
import * as os from "node:os";

import packageJson from "../../package.json" with { type: "json" };
import { migrationEntries } from "../persistence/Migrations.ts";

/**
 * `t3 diagnose` — collects a single copy-pasteable block of system
 * info, package version, migration head, and (optionally) the tail of
 * the most recent log file. The output is plain text designed to drop
 * straight into a GitHub issue or a support thread.
 *
 * We deliberately do NOT include anything user-identifying or
 * project-content-bearing — no auth tokens, no project paths beyond
 * the data directory, no SQL contents. The user can paste the output
 * without redacting.
 */

const sharedFlags = {
  stateDir: Flag.string("state-dir").pipe(Flag.optional),
  tailLogLines: Flag.integer("tail-log-lines").pipe(Flag.withDefault(50)),
};

function formatDiagnose(args: {
  readonly migrationHead: number;
  readonly stateDir: string | undefined;
  readonly stateDirExists: boolean;
  readonly stateDirEntries: ReadonlyArray<string>;
  readonly logTail: string | null;
}): string {
  const lines: string[] = [];
  lines.push("## T3 Code Diagnostics");
  lines.push("");
  lines.push("**Package**");
  lines.push(`- name: ${packageJson.name}`);
  lines.push(`- version: ${packageJson.version}`);
  lines.push("");
  lines.push("**Runtime**");
  lines.push(`- node: ${process.version}`);
  lines.push(`- platform: ${process.platform}`);
  lines.push(`- arch: ${process.arch}`);
  lines.push(`- os release: ${os.release()}`);
  lines.push(`- cpu count: ${os.cpus().length}`);
  lines.push(`- total memory: ${Math.round(os.totalmem() / (1024 * 1024))} MB`);
  lines.push("");
  lines.push("**Database**");
  lines.push(`- known migration head: ${args.migrationHead}`);
  lines.push("");
  lines.push("**State directory**");
  lines.push(`- path: ${args.stateDir ?? "(not specified — pass --state-dir)"}`);
  lines.push(`- exists: ${args.stateDirExists}`);
  if (args.stateDirExists) {
    lines.push("- entries:");
    for (const entry of args.stateDirEntries) {
      lines.push(`  - ${entry}`);
    }
  }
  lines.push("");
  lines.push("**Recent log tail**");
  lines.push(args.logTail ?? "(no log file found in --state-dir/logs)");
  lines.push("");
  return lines.join("\n");
}

export const diagnoseCommand = Command.make(
  "diagnose",
  sharedFlags,
  (flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationHead = migrationEntries.reduce(
        (max, entry) => (entry[0] > max ? entry[0] : max),
        0,
      );
      const stateDir = Option.getOrUndefined(flags.stateDir);

      let stateDirExists = false;
      let stateDirEntries: ReadonlyArray<string> = [];
      let logTail: string | null = null;
      if (stateDir) {
        stateDirExists = yield* fs
          .exists(stateDir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (stateDirExists) {
          stateDirEntries = yield* fs
            .readDirectory(stateDir)
            .pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])));
          // Look for the newest log file in <stateDir>/logs/ and tail it.
          const logsDir = path.join(stateDir, "logs");
          const logsDirExists = yield* fs
            .exists(logsDir)
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
          if (logsDirExists) {
            const logFiles = yield* fs
              .readDirectory(logsDir)
              .pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])));
            const sortedLogs = [...logFiles].sort().reverse();
            const newest = sortedLogs[0];
            if (newest !== undefined) {
              const fullPath = path.join(logsDir, newest);
              const contents = yield* fs
                .readFileString(fullPath)
                .pipe(Effect.catchCause(() => Effect.succeed("")));
              const allLines = contents.split("\n");
              const tail = allLines
                .slice(Math.max(0, allLines.length - flags.tailLogLines - 1))
                .join("\n");
              logTail = `From: ${fullPath}\n\n\`\`\`\n${tail}\n\`\`\``;
            }
          }
        }
      }

      const output = formatDiagnose({
        migrationHead,
        stateDir,
        stateDirExists,
        stateDirEntries,
        logTail,
      });
      yield* Effect.sync(() => {
        process.stdout.write(`${output}\n`);
      });
    }),
).pipe(
  Command.withDescription(
    "Print a copy-pasteable diagnostics block (version, runtime, DB head, recent logs) suitable for issue reports.",
  ),
);
