/**
 * Probe the host PATH for the `almanac` (codealmanac) CLI. Surfaces:
 *   - found:    "almanac 0.2.24"
 *   - missing:  not on PATH
 *   - broken:   on PATH but `--version` exited non-zero
 *
 * Used by the in-app InstallPanel to display "Almanac detected" /
 * "Run `npm i -g codealmanac`" / "Reinstall — pinned Node missing".
 */

import * as Effect from "effect/Effect";
import { ProcessRunner } from "../processRunner.ts";

export interface AlmanacDetectResult {
  readonly state: "found" | "missing" | "broken";
  /** Resolved version, when state === "found". */
  readonly version: string | null;
  /** Last stdout/stderr fragment when state !== "found", for diagnostics. */
  readonly detail: string | null;
}

/**
 * The Almanac launcher exits 1 with a helpful "reinstall" message when
 * the pinned Node binary is gone. We treat that as "broken" rather than
 * "missing" so the UI nudges the user to reinstall rather than install
 * fresh.
 */
const REINSTALL_HINTS = ["pinned node", "install-runtime", "reinstall"] as const;

export const detectAlmanac = Effect.fn("wiki.detectAlmanac")(function* () {
  const runner = yield* ProcessRunner;
  const result = yield* runner
    .run({
      command: "almanac",
      args: ["--version"],
      timeout: "5 seconds",
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          stdout: "",
          stderr: cause instanceof Error ? cause.message : String(cause),
          code: null as number | null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ),
    );

  // Spawn error → not on PATH at all.
  if (result.code === null && result.stderr.toLowerCase().includes("enoent")) {
    return {
      state: "missing",
      version: null,
      detail: null,
    } satisfies AlmanacDetectResult;
  }

  if (result.code === 0 && result.stdout.trim().length > 0) {
    return {
      state: "found",
      version: result.stdout.trim().split(/\s+/).pop() ?? result.stdout.trim(),
      detail: null,
    } satisfies AlmanacDetectResult;
  }

  // Non-zero but with reinstall hint → broken install.
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (REINSTALL_HINTS.some((hint) => combined.includes(hint))) {
    return {
      state: "broken",
      version: null,
      detail: (result.stderr || result.stdout).trim().slice(0, 400),
    } satisfies AlmanacDetectResult;
  }

  // Anything else: treat as missing so the UI offers the install path.
  return {
    state: "missing",
    version: null,
    detail: (result.stderr || result.stdout).trim().slice(0, 400) || null,
  } satisfies AlmanacDetectResult;
});
