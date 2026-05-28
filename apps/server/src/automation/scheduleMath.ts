/**
 * Pure schedule arithmetic for the AutomationScheduler.
 *
 * v1 supports `interval` only — every N minutes. `daily` (HH:MM in a
 * named timezone) is planned but needs proper Effect `DateTime` plumbing
 * to avoid the language-service's `globalDate: error` rule. The schedule
 * column is JSON, so adding a new union member later is migration-free.
 */

import type { AutomationSchedule } from "@t3tools/contracts";

/** Compute the next-fire ms-epoch for the given schedule and `now`. */
export function computeNextFireAt(
  schedule: AutomationSchedule,
  now: number,
  previousRunAt: number | null,
): number {
  // Schedule.kind is always "interval" in v1 — narrowed by the union.
  const intervalMs = schedule.minutes * 60_000;
  // First fire: now + interval (don't burst-fire on enable).
  // Subsequent: previous + interval, clamped to >= now + interval so we
  // don't catch up missed intervals after a long pause.
  if (previousRunAt === null) return now + intervalMs;
  const candidate = previousRunAt + intervalMs;
  return candidate < now ? now + intervalMs : candidate;
}
