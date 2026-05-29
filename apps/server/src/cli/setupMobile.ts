import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildTailscaleHttpsBaseUrl,
  DEFAULT_TAILSCALE_SERVE_PORT,
  ensureTailscaleServe,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
  TailscaleCommandError,
  TailscaleStatusParseError,
} from "@t3tools/tailscale";

/**
 * `t3 setup-mobile` — interactive walkthrough that gets the local
 * server reachable from a phone over Tailscale.
 *
 * Steps the command takes, each printed as a numbered checkbox so the
 * user can follow along:
 *   1. Detect the `tailscale` binary on PATH. If missing, print the
 *      OS-specific install command and exit (we can't bootstrap a
 *      package manager from inside Node).
 *   2. Read `tailscale status --json`. If the daemon is unreachable
 *      or the device isn't logged in, print the `tailscale up`
 *      command and ask the user to run it, then re-invoke us.
 *   3. Confirm MagicDNS is on (status.magicDnsName must be non-null).
 *      Otherwise print the Tailscale admin URL with one-line
 *      instructions to enable it.
 *   4. Run `tailscale serve --bg --https=<port> http://127.0.0.1:<localPort>`.
 *   5. Probe the resulting HTTPS URL to confirm reachability.
 *   6. Print the final URL for the phone — add-to-home-screen for the
 *      PWA, hit the pairing link once, done.
 *
 * Non-interactive on purpose: we never prompt for input. Every step
 * either succeeds and moves on or prints the exact next command the
 * user should run, then exits 0 (idempotent — re-invocation picks up
 * where it left off).
 */

const flags = {
  localPort: Flag.integer("port").pipe(
    Flag.withDefault(3773),
    Flag.withDescription("Local HTTP port T3 is listening on (default: 3773)."),
  ),
  localHost: Flag.string("host").pipe(
    Flag.withDefault("127.0.0.1"),
    Flag.withDescription("Local interface T3 is bound to (default: 127.0.0.1)."),
  ),
  servePort: Flag.integer("https-port").pipe(
    Flag.withDefault(DEFAULT_TAILSCALE_SERVE_PORT),
    Flag.withDescription(`HTTPS port for Tailscale Serve (default: ${DEFAULT_TAILSCALE_SERVE_PORT}).`),
  ),
  skipProbe: Flag.boolean("skip-probe").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Skip the final reachability probe (saves ~3s when you know the server isn't running yet)."),
  ),
};

const line = (message: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${message}\n`);
  });

const blank = line("");

// Box-drawing prefixes — keep the output tidy on every terminal width.
const STEP = (n: number, body: string) => line(`${n}. ${body}`);
const TICK = (body: string) => line(`   ✓ ${body}`);
const CROSS = (body: string) => line(`   ✗ ${body}`);
const HINT = (body: string) => line(`     ${body}`);

/** Spawn `tailscale version` and check the exit code. We don't bother
 *  reading stdout — the presence of an exit-0 is enough to confirm
 *  the binary is on PATH. */
const detectTailscale: Effect.Effect<
  boolean,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .spawn(
      ChildProcess.make("tailscale", ["version"], {
        shell: process.platform === "win32",
      }),
    )
    .pipe(
      Effect.flatMap((child) => child.exitCode.pipe(Effect.map((code) => Number(code) === 0))),
      Effect.scoped,
      Effect.timeoutOption(Duration.seconds(3)),
      Effect.map((option) =>
        Option.match(option, {
          onNone: () => false,
          onSome: (b) => b,
        }),
      ),
      Effect.catchCause(() => Effect.succeed(false)),
    );
});

function installInstructions(): readonly string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "Install Tailscale (macOS):",
        "  brew install --cask tailscale",
        "or download from https://tailscale.com/download/macos",
      ];
    case "linux":
      return [
        "Install Tailscale (Linux):",
        "  curl -fsSL https://tailscale.com/install.sh | sh",
      ];
    case "win32":
      return [
        "Install Tailscale (Windows):",
        "  winget install tailscale.tailscale",
        "or download from https://tailscale.com/download/windows",
      ];
    default:
      return [
        "Install Tailscale: https://tailscale.com/download",
      ];
  }
}

export const setupMobileCommand = Command.make(
  "setup-mobile",
  flags,
  (parsed) =>
    Effect.gen(function* () {
      yield* line("T3 Code — mobile setup walkthrough");
      yield* line("===================================");
      yield* blank;
      yield* line("This will get T3 reachable from your phone over Tailscale.");
      yield* line("Each step is idempotent — safe to re-run any time.");
      yield* blank;

      // -----------------------------------------------------------------
      // Step 1 — tailscale binary on PATH?
      // -----------------------------------------------------------------
      yield* STEP(1, "Checking for the Tailscale CLI…");
      const present = yield* detectTailscale;
      if (!present) {
        yield* CROSS("`tailscale` is not on your PATH.");
        for (const instruction of installInstructions()) {
          yield* HINT(instruction);
        }
        yield* HINT("After installing, re-run: t3 setup-mobile");
        return;
      }
      yield* TICK("Tailscale CLI found.");
      yield* blank;

      // -----------------------------------------------------------------
      // Step 2 — logged in?
      // -----------------------------------------------------------------
      yield* STEP(2, "Checking Tailscale login state…");
      const statusResult = yield* readTailscaleStatus.pipe(
        Effect.map((s) => ({ kind: "ok" as const, status: s })),
        Effect.catchTag("TailscaleCommandError", (err: TailscaleCommandError) =>
          Effect.succeed({ kind: "command-error" as const, err }),
        ),
        Effect.catchTag("TailscaleStatusParseError", (err: TailscaleStatusParseError) =>
          Effect.succeed({ kind: "parse-error" as const, err }),
        ),
      );

      if (statusResult.kind === "command-error") {
        yield* CROSS("Tailscale isn't logged in (or the daemon isn't running).");
        yield* HINT("Run: tailscale up");
        yield* HINT("That command prints a one-time auth URL — open it in any browser,");
        yield* HINT("approve the device, then re-run: t3 setup-mobile");
        yield* blank;
        yield* HINT(`(diagnostic: ${statusResult.err.message})`);
        return;
      }
      if (statusResult.kind === "parse-error") {
        yield* CROSS("Couldn't parse `tailscale status --json` output.");
        yield* HINT("Try: tailscale update");
        yield* HINT("Then re-run: t3 setup-mobile");
        return;
      }
      const { status } = statusResult;
      yield* TICK("Logged in.");
      yield* blank;

      // -----------------------------------------------------------------
      // Step 3 — MagicDNS?
      // -----------------------------------------------------------------
      yield* STEP(3, "Checking MagicDNS…");
      if (!status.magicDnsName) {
        yield* CROSS("MagicDNS is not enabled (no DNS name on this device).");
        yield* HINT("Open https://login.tailscale.com/admin/dns");
        yield* HINT("Toggle on **MagicDNS** (and **HTTPS Certificates** below it),");
        yield* HINT("then re-run: t3 setup-mobile");
        return;
      }
      yield* TICK(`MagicDNS name: ${status.magicDnsName}`);
      yield* blank;

      // -----------------------------------------------------------------
      // Step 4 — serve.
      // -----------------------------------------------------------------
      yield* STEP(
        4,
        `Setting up tailscale serve --https=${parsed.servePort} → http://${parsed.localHost}:${parsed.localPort}`,
      );
      const serveResult = yield* ensureTailscaleServe({
        localPort: parsed.localPort,
        servePort: parsed.servePort,
        localHost: parsed.localHost,
      }).pipe(
        Effect.map(() => ({ kind: "ok" as const })),
        Effect.catchTag("TailscaleCommandError", (err: TailscaleCommandError) =>
          Effect.succeed({ kind: "error" as const, err }),
        ),
      );
      if (serveResult.kind === "error") {
        yield* CROSS("Tailscale serve refused.");
        yield* HINT(`Error: ${serveResult.err.message}`);
        if (serveResult.err.stderr.trim()) {
          yield* HINT(`stderr: ${serveResult.err.stderr.trim().slice(0, 200)}`);
        }
        yield* HINT("Common causes:");
        yield* HINT("  - Run the same user that owns the tailscaled session (no sudo here).");
        yield* HINT(`  - Port ${parsed.servePort} already in use — try --https-port 8443.`);
        yield* HINT("  - On macOS, allow Tailscale through System Settings → Network.");
        return;
      }
      yield* TICK("Serve is up.");
      yield* blank;

      const baseUrl = buildTailscaleHttpsBaseUrl({
        magicDnsName: status.magicDnsName,
        ...(parsed.servePort === DEFAULT_TAILSCALE_SERVE_PORT ? {} : { servePort: parsed.servePort }),
      });

      // -----------------------------------------------------------------
      // Step 5 — reachability probe.
      // -----------------------------------------------------------------
      if (!parsed.skipProbe) {
        yield* STEP(5, "Probing the HTTPS endpoint…");
        const reachable = yield* probeTailscaleHttpsEndpoint({ baseUrl });
        if (reachable) {
          yield* TICK(`Reachable at ${baseUrl}`);
        } else {
          yield* CROSS("Probe failed — server might not be running yet, or DNS hasn't propagated.");
          yield* HINT("Start the server in another terminal: t3 start");
          yield* HINT(`Then visit ${baseUrl} on your phone.`);
        }
      } else {
        yield* STEP(5, "Skipping probe (--skip-probe).");
      }
      yield* blank;

      // -----------------------------------------------------------------
      // Step 6 — final URL + next steps.
      // -----------------------------------------------------------------
      yield* line("─────────────────────────────────────────────────────────");
      yield* line(`📱 Open this URL on your phone (same tailnet):`);
      yield* line(`   ${baseUrl}`);
      yield* line("");
      yield* line("Next:");
      yield* line("  1. Visit the pairing URL printed by `t3 start` once.");
      yield* line("  2. Add to home screen for the PWA.");
      yield* line(`  3. Tear down later with: tailscale serve --https=${parsed.servePort} off`);
      yield* line("─────────────────────────────────────────────────────────");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
).pipe(
  Command.withDescription(
    "Walk through Tailscale install/login/serve and get T3 reachable from your phone.",
  ),
);
