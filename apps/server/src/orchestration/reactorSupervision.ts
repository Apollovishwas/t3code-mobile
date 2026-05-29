import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Wrap a long-running reactor effect (typically a `Stream.runForEach`)
 * so that:
 *   1. Failures and defects are logged with `Effect.logError` — no
 *      silent death.
 *   2. The effect is restarted with a small backoff (5s) after any
 *      failure, so a transient bug in the handler doesn't permanently
 *      brick the reactor — the server keeps running and the reactor
 *      survives the kind of one-off "T3 went silent" failures that
 *      would otherwise require a process restart.
 *
 * The wrapper is intentionally generic so every reactor uses the same
 * supervision shape; future per-reactor heartbeats / circuit-breakers
 * live here.
 *
 * @param name - Short identifier used in the log message (e.g.
 *               "push.reactor", "provider.runtime.ingestion.events").
 * @param effect - The reactor body. Typically `Stream.runForEach(...)`
 *                 that runs forever.
 */
export const superviseReactor = <E, R>(
  name: string,
  effect: Effect.Effect<unknown, E, R>,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logError(`reactor ${name} died — restarting in 5s`, { cause }),
    ),
    Effect.repeat(Schedule.spaced(Duration.seconds(5))),
    Effect.asVoid,
  );
