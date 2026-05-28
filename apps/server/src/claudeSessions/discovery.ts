/**
 * Read-only discovery of existing Claude Code sessions on disk.
 *
 * Claude Code CLI stores each session as a JSONL transcript under
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. We enumerate those
 * to power the "resume an existing Claude session" thread-creation flow: list
 * folders that have history, and list the most recent sessions per folder.
 *
 * We never reconstruct the encoded directory name (Claude's encoding has edge
 * cases); instead we read each transcript's own `cwd` field, which is
 * authoritative. Parsing is bounded to the file head — `cwd` and the first user
 * message always appear near the top — so large transcripts stay cheap.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../os-jank.ts";

export interface ClaudeSessionSummary {
  readonly sessionId: string;
  readonly cwd: string;
  /** First user prompt (trimmed/truncated) used as a human-readable title. */
  readonly title: string;
  /** ISO timestamp of last activity (file mtime). */
  readonly lastActivity: string;
}

export interface ClaudeSessionFolder {
  readonly cwd: string;
  readonly sessionCount: number;
  readonly lastActivity: string;
}

const DEFAULT_SESSION_LIMIT = 10;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
// Only inspect the head of each transcript — cwd + first prompt live up top.
const MAX_PARSED_LINES = 80;
const MAX_TITLE_LENGTH = 80;

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pull a displayable user-message string out of a parsed transcript line. */
function userTextFromLine(record: Record<string, unknown>): string | undefined {
  if (record["type"] !== "user") {
    return undefined;
  }
  const message = asRecord(record["message"]);
  const content = message?.["content"];
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const b = asRecord(block);
        return b && b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
      })
      .join(" ");
  }
  text = text?.trim();
  // Skip tool results / synthetic command wrappers — not real user prompts.
  if (!text || text.startsWith("[") || text.startsWith("<")) {
    return undefined;
  }
  return text;
}

function extractMeta(content: string): { cwd?: string; title?: string } {
  const lines = content.split("\n");
  let cwd: string | undefined;
  let title: string | undefined;
  const limit = Math.min(lines.length, MAX_PARSED_LINES);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const parsed = decodeJsonLine(line);
    if (Option.isNone(parsed)) continue;
    const record = asRecord(parsed.value);
    if (!record) continue;
    if (cwd === undefined && typeof record["cwd"] === "string") {
      cwd = record["cwd"];
    }
    if (title === undefined) {
      const userText = userTextFromLine(record);
      if (userText) {
        title =
          userText.length > MAX_TITLE_LENGTH ? `${userText.slice(0, MAX_TITLE_LENGTH)}…` : userText;
      }
    }
    if (cwd !== undefined && title !== undefined) break;
  }
  return { ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) };
}

/** Scans every Claude session transcript into a flat summary list. */
const scanAllSessions: Effect.Effect<
  ReadonlyArray<ClaudeSessionSummary>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectsRoot = yield* expandHomePath("~/.claude/projects");

  const rootExists = yield* fs.exists(projectsRoot).pipe(Effect.orElseSucceed(() => false));
  if (!rootExists) {
    return [];
  }

  const projectDirs = yield* fs.readDirectory(projectsRoot).pipe(Effect.orElseSucceed(() => []));

  const perDir = yield* Effect.forEach(
    projectDirs,
    (dirName) =>
      Effect.gen(function* () {
        const dirPath = path.join(projectsRoot, dirName);
        const stat = yield* fs.stat(dirPath).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "Directory") {
          return [] as ReadonlyArray<ClaudeSessionSummary>;
        }
        const entries = yield* fs.readDirectory(dirPath).pipe(Effect.orElseSucceed(() => []));
        const sessionFiles = entries.filter((name) => name.endsWith(".jsonl"));
        return yield* Effect.forEach(
          sessionFiles,
          (fileName) =>
            Effect.gen(function* () {
              const filePath = path.join(dirPath, fileName);
              const info = yield* fs.stat(filePath).pipe(Effect.option);
              const content = yield* fs
                .readFileString(filePath)
                .pipe(Effect.orElseSucceed(() => ""));
              const meta = extractMeta(content);
              if (!meta.cwd) {
                return Option.none<ClaudeSessionSummary>();
              }
              const mtime = Option.isSome(info) ? info.value.mtime : Option.none<Date>();
              const lastActivity = Option.isSome(mtime) ? mtime.value.toISOString() : EPOCH_ISO;
              return Option.some<ClaudeSessionSummary>({
                sessionId: fileName.replace(/\.jsonl$/, ""),
                cwd: meta.cwd,
                title: meta.title ?? "(untitled session)",
                lastActivity,
              });
            }),
          { concurrency: 8 },
        ).pipe(Effect.map((items) => items.filter(Option.isSome).map((o) => o.value)));
      }),
    { concurrency: 4 },
  );

  return perDir.flat();
});

/** Folders that have at least one Claude session, newest activity first. */
export const listClaudeSessionFolders: Effect.Effect<
  ReadonlyArray<ClaudeSessionFolder>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.map(scanAllSessions, (sessions) => {
  const byCwd = new Map<string, { count: number; lastActivity: string }>();
  for (const session of sessions) {
    const existing = byCwd.get(session.cwd);
    if (existing) {
      existing.count += 1;
      if (session.lastActivity > existing.lastActivity)
        existing.lastActivity = session.lastActivity;
    } else {
      byCwd.set(session.cwd, { count: 1, lastActivity: session.lastActivity });
    }
  }
  return [...byCwd.entries()]
    .map(([cwd, { count, lastActivity }]) => ({ cwd, sessionCount: count, lastActivity }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
});

// Session ids are filenames (UUIDs). Restrict to UUID-safe characters so a
// crafted id can never escape the projects directory (path traversal).
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/**
 * Permanently deletes a Claude session transcript by id. Returns whether a
 * matching file was found and removed. Read-only-safe: only ever removes a
 * file literally named `<sessionId>.jsonl` under `~/.claude/projects`.
 */
export const deleteClaudeSession = (
  sessionId: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return false;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsRoot = yield* expandHomePath("~/.claude/projects");
    const rootExists = yield* fs.exists(projectsRoot).pipe(Effect.orElseSucceed(() => false));
    if (!rootExists) {
      return false;
    }
    const projectDirs = yield* fs.readDirectory(projectsRoot).pipe(Effect.orElseSucceed(() => []));
    const fileName = `${sessionId}.jsonl`;
    let deleted = false;
    for (const dirName of projectDirs) {
      const candidate = path.join(projectsRoot, dirName, fileName);
      const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        const removed = yield* fs.remove(candidate).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (removed) {
          deleted = true;
        }
      }
    }
    return deleted;
  });

/** Most-recent sessions for a folder (default 10), newest first. */
export const listClaudeSessionsForCwd = (
  cwd: string,
  limit: number = DEFAULT_SESSION_LIMIT,
): Effect.Effect<ReadonlyArray<ClaudeSessionSummary>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.map(scanAllSessions, (sessions) =>
    sessions
      .filter((session) => session.cwd === cwd)
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
      .slice(0, Math.max(1, limit)),
  );
