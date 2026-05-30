import { useCallback, useEffect, useRef, useState } from "react";
import { GlobeIcon, RotateCwIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { haptic } from "~/lib/haptics";

/**
 * In-app browser pane. Renders a proxied iframe (served same-origin through
 * `/api/preview` so it loads over Tailscale, embeds, and is interceptable).
 *
 * Behaviour:
 *   - Fills the messages area as an animated overlay; the composer (a sibling
 *     outside this pane's container) stays visible so you can keep chatting.
 *   - Address bar to type/paste a URL; reload + close.
 *   - Link clicks inside the page are intercepted by the injected proxy script
 *     and surfaced here via postMessage → an in-pane confirm bar → navigate
 *     within the pane. Nothing ever opens a real browser tab.
 *   - On open with no URL, auto-detects a running dev server.
 */

function toProxySrc(url: string): string {
  return `/api/preview?url=${encodeURIComponent(url)}`;
}

function normalizeInputUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

interface BrowserPaneProps {
  readonly open: boolean;
  readonly url: string | null;
  readonly onUrlChange: (url: string) => void;
  readonly onClose: () => void;
}

export function BrowserPane({ open, url, onUrlChange, onClose }: BrowserPaneProps) {
  const [addressDraft, setAddressDraft] = useState(url ?? "");
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Keep the address bar in sync with the active URL (e.g. after a confirmed
  // in-page navigation), but don't clobber what the user is typing.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setAddressDraft(url ?? "");
  }, [url]);

  // On open with no URL yet, auto-detect a dev server to seed the bar.
  useEffect(() => {
    if (!open || url) return;
    let cancelled = false;
    void fetch("/api/preview/detect", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { devServer?: { url?: string } | null }) => {
        if (cancelled) return;
        const detected = data.devServer?.url;
        if (detected) onUrlChange(detected);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, url, onUrlChange]);

  // Listen for messages from the proxied page (link clicks → confirm).
  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "t3-preview:navigate" && typeof data.url === "string") {
        setPendingNav(data.url);
      }
      // `t3-preview:loaded` could update a title; address bar already tracks url.
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  const submitAddress = useCallback(() => {
    const normalized = normalizeInputUrl(addressDraft);
    if (normalized) {
      haptic("tap");
      onUrlChange(normalized);
    }
  }, [addressDraft, onUrlChange]);

  const confirmNav = useCallback(() => {
    if (!pendingNav) return;
    haptic("action");
    onUrlChange(pendingNav);
    setPendingNav(null);
  }, [pendingNav, onUrlChange]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex flex-col bg-background",
        // Entry animation — fade + slight rise.
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200",
      )}
      role="dialog"
      aria-label="In-app browser"
    >
      {/* Address bar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5">
        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="url"
          inputMode="url"
          value={addressDraft}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
          }}
          onChange={(e) => setAddressDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAddress();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Enter a URL or localhost:3000…"
          // 16px on mobile prevents iOS zoom-on-focus.
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-base outline-none focus:border-ring md:text-xs"
        />
        <button
          type="button"
          onClick={() => {
            haptic("tap");
            setReloadKey((k) => k + 1);
          }}
          aria-label="Reload"
          disabled={!url}
          className="shrink-0 rounded-md border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
        >
          <RotateCwIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            haptic("tap");
            onClose();
          }}
          aria-label="Close browser"
          className="shrink-0 rounded-md border border-border p-1 text-muted-foreground hover:bg-muted"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {/* Confirmation bar for an intercepted link click */}
      {pendingNav ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-foreground">
            Open <span className="font-mono">{pendingNav}</span>?
          </span>
          <button
            type="button"
            onClick={confirmNav}
            className="shrink-0 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => setPendingNav(null)}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px]"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {/* The proxied page */}
      <div className="relative min-h-0 flex-1 bg-white dark:bg-zinc-950">
        {url ? (
          <iframe
            key={`${url}#${reloadKey}`}
            ref={iframeRef}
            src={toProxySrc(url)}
            title="In-app browser"
            // allow-same-origin is required for the proxied app's localStorage /
            // client routing to work (it's served from T3's origin). Known v1
            // tradeoff: a proxied page runs on T3's origin — fine for your own
            // dev server on a private tailnet; a separate proxy origin is the
            // hardening follow-up for browsing untrusted sites.
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Enter a URL above, or start your dev server and reopen — T3 will
              auto-detect it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
