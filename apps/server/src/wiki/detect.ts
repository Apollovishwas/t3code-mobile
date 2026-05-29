import * as Effect from "effect/Effect";

/**
 * Legacy stub. v1 (Almanac-based) probed the host PATH for the
 * `codealmanac` CLI. The DIY rewrite (2026-05-29) does all wiki work
 * in-process — the running Claude Code session reads/writes
 * `.t3/wiki/*.md` directly, paid for by the user's existing
 * subscription. There is nothing external to detect.
 *
 * The endpoint stays so the install panel's existing JSON shape is
 * preserved — it now reports `state: "found"` unconditionally, which
 * makes the "Initialise wiki here" button always render.
 */

export interface AlmanacDetectResult {
  readonly state: "found" | "missing" | "broken";
  readonly version: string | null;
  readonly detail: string | null;
}

export const detectAlmanac = Effect.fn("wiki.detectAlmanac")(function* () {
  return {
    state: "found",
    version: "t3-builtin",
    detail: null,
  } satisfies AlmanacDetectResult;
});
