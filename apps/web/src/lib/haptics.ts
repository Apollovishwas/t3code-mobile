/**
 * Tiny haptic-feedback helper around the Vibration API.
 *
 * Native apps buzz on meaningful actions (tap-to-send, task done, approve).
 * On the web the only portable primitive is `navigator.vibrate`, which works
 * on Android Chrome and installed Android PWAs. iOS Safari does NOT support
 * it — calls are silently no-ops there, which is fine: we degrade to nothing
 * rather than erroring.
 *
 * Respects:
 *   - `prefers-reduced-motion` (users who opt out of motion also tend to want
 *     no haptics).
 *   - A per-device localStorage opt-out (`t3.haptics.enabled`) so it can be
 *     turned off without a server round-trip.
 */

const STORAGE_KEY = "t3.haptics.enabled";

/** Named patterns, in ms. A single number = one buzz; arrays alternate
 *  vibrate/pause. Kept short — long buzzes feel cheap. */
const PATTERNS = {
  /** Light confirmation — tab switch, chip tap, toggle. */
  tap: 8,
  /** Medium — send a message, run an action. */
  action: 15,
  /** Success — a turn finished, a task moved to done. */
  success: [10, 40, 10],
  /** Warning / needs-attention — approval requested, error. */
  warning: [20, 60, 20],
} as const;

export type HapticPattern = keyof typeof PATTERNS;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Per-device opt-out. Defaults to enabled. */
export function hapticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setHapticsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore — non-fatal
  }
}

/**
 * Fire a haptic pattern. Safe to call anywhere — no-ops when unsupported,
 * disabled, or the user prefers reduced motion.
 */
export function haptic(pattern: HapticPattern = "tap"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return;
  }
  if (!hapticsEnabled() || prefersReducedMotion()) {
    return;
  }
  try {
    const value = PATTERNS[pattern];
    // Copy readonly tuples into a mutable array — navigator.vibrate's type
    // is `number | number[]` and rejects the `as const` readonly tuple.
    navigator.vibrate(typeof value === "number" ? value : [...value]);
  } catch {
    // Some browsers throw if called outside a user gesture; ignore.
  }
}
