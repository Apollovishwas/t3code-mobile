import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  buildInjectedScript,
  rewriteCss,
  rewriteHtml,
} from "./proxyRewrite.ts";

/**
 * In-app browser proxy.
 *
 * `GET /api/preview?url=<target>` fetches the target server-side and returns
 * it from T3's own origin so the PWA can embed it in an iframe over Tailscale:
 *   - strips X-Frame-Options / CSP frame-ancestors so it embeds;
 *   - rewrites URLs + injects a runtime shim (see proxyRewrite.ts) so links,
 *     assets, and SPA fetch/XHR route back through the proxy;
 *   - link clicks are surfaced to the parent for a confirm dialog — nothing
 *     escapes to a real browser tab.
 *
 * Single-user self-hosted tool on the owner's tailnet, so the threat model is
 * light, but we still: allow only http(s), and block the cloud-metadata IP to
 * avoid the classic SSRF pivot.
 */

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap per resource

// Headers we must not forward back to the iframe (they'd block embedding) or
// upstream (hop-by-hop / would confuse the proxy).
const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding", // we hand back decoded bytes; let the platform re-encode
  "content-length",
  "transfer-encoding",
  "connection",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // Cloud instance metadata — the one SSRF target worth hard-blocking.
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  return false;
}

function validateTarget(raw: string | null): { ok: true; url: string } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: "Missing ?url= parameter." };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "Malformed URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http(s) URLs can be previewed." };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, reason: "That host is blocked." };
  }
  return { ok: true, url: parsed.toString() };
}

export const previewProxyRouteLayer = HttpRouter.add(
  "GET",
  "/api/preview",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const target = validateTarget(url.searchParams.get("url"));
    if (!target.ok) {
      return HttpServerResponse.text(target.reason, { status: 400 });
    }

    // Effect.promise + internal try/catch → the async fn always resolves to a
    // discriminated result, so there's no untagged-Error failure channel.
    const fetched = yield* Effect.promise(
      async (): Promise<
        | { readonly ok: true; readonly upstream: Response; readonly buf: Uint8Array }
        | { readonly ok: false; readonly error: string }
      > => {
        try {
          const upstream = await fetch(target.url, {
            redirect: "follow",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
              // Present as a normal browser so dev servers / sites behave.
              "User-Agent":
                "Mozilla/5.0 (T3CodePreview) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
          });
          const buf = new Uint8Array(await upstream.arrayBuffer());
          return { ok: true, upstream, buf };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      },
    );

    if (!fetched.ok) {
      return HttpServerResponse.text(
        `Could not load ${target.url}: ${fetched.error}`,
        { status: 502 },
      );
    }

    const { upstream, buf } = fetched;
    if (buf.byteLength > MAX_BYTES) {
      return HttpServerResponse.text("Resource too large to preview.", { status: 413 });
    }

    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    // The URL we actually ended up at (after redirects) is the rewrite base.
    const finalUrl = upstream.url || target.url;

    // Pass through the upstream headers minus the frame-blocking / hop ones.
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers[key] = value;
    });

    if (contentType.includes("text/html")) {
      const html = new TextDecoder().decode(buf);
      const rewritten = rewriteHtml(html, finalUrl, buildInjectedScript(finalUrl));
      return HttpServerResponse.text(rewritten, {
        status: upstream.status,
        contentType: "text/html; charset=utf-8",
        headers,
      });
    }

    if (contentType.includes("text/css")) {
      const css = new TextDecoder().decode(buf);
      return HttpServerResponse.text(rewriteCss(css, finalUrl), {
        status: upstream.status,
        contentType: "text/css; charset=utf-8",
        headers,
      });
    }

    // Everything else (JS, images, fonts, JSON, …) passes through untouched.
    return HttpServerResponse.uint8Array(buf, {
      status: upstream.status,
      contentType: contentType || "application/octet-stream",
      headers,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/preview/detect — probe common dev-server ports for a listener.
// ---------------------------------------------------------------------------

const DEV_PORTS = [3000, 3001, 5173, 5174, 4321, 8080, 8000, 4173] as const;

export const previewDetectRouteLayer = HttpRouter.add(
  "GET",
  "/api/preview/detect",
  Effect.gen(function* () {
    const found = yield* Effect.tryPromise({
      try: async () => {
        for (const port of DEV_PORTS) {
          const candidate = `http://localhost:${port}`;
          try {
            const res = await fetch(candidate, { signal: AbortSignal.timeout(600) });
            // Any HTTP response (even 404) means something is listening.
            if (res) return { url: candidate, port };
          } catch {
            // not listening / refused / timed out — try next
          }
        }
        return null;
      },
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)));

    return HttpServerResponse.jsonUnsafe({ devServer: found }, { status: 200 });
  }),
);
