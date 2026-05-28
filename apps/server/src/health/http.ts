import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { migrationEntries } from "../persistence/Migrations.ts";

/**
 * Lightweight unauthenticated health endpoint. Returns the package
 * version, current process uptime in seconds (via `process.uptime()`),
 * and the highest-numbered SQL migration the binary knows about.
 * Intended for:
 *  - `npx t3` style local verification
 *  - Tailscale serve / reverse-proxy health probes
 *  - systemd `Type=notify` or container orchestration liveness checks
 *
 * Deliberately includes nothing user-identifiable or operationally
 * sensitive (no subject ids, no project paths, no pairing tokens). If
 * you can hit this you've already crossed the network boundary, but
 * we still treat the response as crawler-grade public.
 */
const dbMigrationHead = migrationEntries.reduce(
  (max, entry) => (entry[0] > max ? entry[0] : max),
  0,
);

export const healthRouteLayer = HttpRouter.add(
  "GET",
  "/health",
  Effect.gen(function* () {
    return HttpServerResponse.jsonUnsafe(
      {
        status: "ok",
        package: packageJson.name,
        version: packageJson.version,
        // `process.uptime()` returns the seconds since process start
        // without touching the system clock — no `globalDate` lint hit.
        uptimeSeconds: Math.round(process.uptime()),
        dbMigrationHead,
        nodeVersion: process.version,
      },
      { status: 200 },
    );
  }),
);
