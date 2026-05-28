import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };

/**
 * Once per startup, fetch the published `latest` version of `t3` from
 * npm and, if it's newer than what's running, log a one-line notice.
 *
 * Deliberately non-blocking: any failure (offline, registry timeout,
 * unexpected response shape) is swallowed silently. We never want a
 * registry hiccup to slow down `t3 start`.
 *
 * The user can disable this entirely by setting `T3_DISABLE_UPDATE_CHECK=1`
 * — useful for air-gapped installs and to suppress the curl-shaped
 * outbound request when their tailnet policy forbids it.
 */
const REGISTRY_URL = "https://registry.npmjs.org/t3/latest";
const TIMEOUT = Duration.seconds(3);

class RegistryError extends Schema.TaggedErrorClass<RegistryError>()("RegistryError", {
  message: Schema.String,
}) {}

interface RegistryResponse {
  readonly version?: string;
}

function parseSemver(value: string): [number, number, number] | null {
  const cleaned = value.replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(remote: string, local: string): boolean {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i]! > l[i]!) return true;
    if (r[i]! < l[i]!) return false;
  }
  return false;
}

const fetchLatest = Effect.tryPromise({
  try: () =>
    fetch(REGISTRY_URL, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    }).then((response) => {
      if (!response.ok) throw new Error(`registry ${response.status}`);
      return response.json() as Promise<RegistryResponse>;
    }),
  catch: (cause) => new RegistryError({ message: String(cause) }),
}).pipe(Effect.timeout(TIMEOUT));

export const checkForUpdate = Effect.fn("checkForUpdate")(function* () {
  if (process.env["T3_DISABLE_UPDATE_CHECK"]) return;
  const local = packageJson.version;
  const fetchResult = yield* fetchLatest.pipe(
    Effect.catchCause(() => Effect.succeed<RegistryResponse | null>(null)),
  );
  if (!fetchResult || typeof fetchResult.version !== "string") return;
  const remote = fetchResult.version;
  if (!isNewer(remote, local)) return;
  yield* Effect.logInfo(
    `A new version of t3 is available: ${local} → ${remote}. Run \`npm i -g t3@latest\` to upgrade.`,
  );
});
