/**
 * HTML rewriting for the in-app browser proxy.
 *
 * The proxy serves foreign pages from T3's own origin so they (a) load over
 * Tailscale, (b) embed in an iframe (frame-blocking headers stripped), and
 * (c) have their links interceptable (same-origin). For all that to work, every
 * URL the page references must be rewritten to route back through the proxy.
 *
 * Strategy:
 *   - Rewrite href / src / action / srcset / poster / form-action and CSS
 *     `url(...)` to `/api/preview?url=<absolute>`.
 *   - Inject a script that (1) intercepts anchor clicks → postMessage to the
 *     parent for a confirm dialog, (2) monkeypatches fetch + XHR so runtime
 *     requests (SPA data fetches like `/api/chat`) also go through the proxy.
 *
 * This is a pragmatic regex rewriter, not a full HTML parser — good enough for
 * dev-server pages + ordinary sites. Known v1 gaps: dynamically string-built
 * URLs inside already-bundled JS that bypass fetch/XHR (rare), and WebSockets
 * (HMR live-reload) which we don't proxy.
 */

const PROXY_PATH = "/api/preview";

/** Build the same-origin proxy URL for an absolute target URL. */
export function toProxyUrl(absoluteUrl: string): string {
  return `${PROXY_PATH}?url=${encodeURIComponent(absoluteUrl)}`;
}

/** Resolve a possibly-relative URL against the page's base, returning the
 *  proxied form. Returns the original value untouched for things we must not
 *  touch (data:, blob:, javascript:, mailto:, #fragments, already-proxied). */
function rewriteOne(value: string, baseUrl: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith(PROXY_PATH)
  ) {
    return value;
  }
  try {
    const absolute = new URL(trimmed, baseUrl).toString();
    return toProxyUrl(absolute);
  } catch {
    return value;
  }
}

/** Rewrite a `srcset` (comma-separated `url descriptor` pairs). */
function rewriteSrcset(value: string, baseUrl: string): string {
  return value
    .split(",")
    .map((part) => {
      const seg = part.trim();
      if (seg.length === 0) return seg;
      const spaceIdx = seg.search(/\s/);
      const url = spaceIdx === -1 ? seg : seg.slice(0, spaceIdx);
      const descriptor = spaceIdx === -1 ? "" : seg.slice(spaceIdx);
      return `${rewriteOne(url, baseUrl)}${descriptor}`;
    })
    .join(", ");
}

const ATTR_RE = /\b(href|src|action|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /\b(srcset|imagesrcset)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const INTEGRITY_RE = /\sintegrity\s*=\s*("[^"]*"|'[^']*')/gi;

/** Rewrite all URL-bearing attributes + CSS url() in an HTML/CSS string. */
export function rewriteHtml(html: string, baseUrl: string, injectedScript: string): string {
  let out = html;

  // Drop subresource-integrity — we don't alter linked bytes, but proxied
  // URLs + any header massaging can trip SRI; safer to remove it.
  out = out.replace(INTEGRITY_RE, "");

  // Standard URL attributes.
  out = out.replace(ATTR_RE, (_m, attr: string, _q: string, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    return `${attr}="${rewriteOne(raw, baseUrl)}"`;
  });

  // srcset variants.
  out = out.replace(SRCSET_RE, (_m, attr: string, _q: string, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    return `${attr}="${rewriteSrcset(raw, baseUrl)}"`;
  });

  // CSS url() in inline styles / <style> blocks.
  out = out.replace(CSS_URL_RE, (_m, quote: string, raw: string) => {
    return `url(${quote}${rewriteOne(raw, baseUrl)}${quote})`;
  });

  // Inject our runtime script as early as possible. Prefer right after <head>,
  // else before </head>, else prepend.
  const tag = `<script data-t3-preview="1">${injectedScript}</script>`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  } else if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${tag}</head>`);
  } else {
    out = `${tag}${out}`;
  }
  return out;
}

/** Rewrite a standalone CSS file's url() references. */
export function rewriteCss(css: string, baseUrl: string): string {
  return css.replace(CSS_URL_RE, (_m, quote: string, raw: string) => {
    return `url(${quote}${rewriteOne(raw, baseUrl)}${quote})`;
  });
}

/**
 * The script injected into every proxied HTML page. Runs in the iframe:
 *   - Intercepts same-tab anchor navigations + window.open → postMessage to
 *     the parent (T3) so it can show a confirm dialog and drive the address
 *     bar. Nothing ever escapes to a real browser tab.
 *   - Monkeypatches fetch + XHR so runtime requests resolve against the real
 *     target origin and route through the proxy (so SPA data calls work).
 *
 * `baseUrl` is the absolute URL of the page being viewed.
 */
export function buildInjectedScript(baseUrl: string): string {
  // The script is a self-contained IIFE. baseUrl is JSON-encoded so it's safe
  // to embed. PROXY_PATH is inlined.
  const base = JSON.stringify(baseUrl);
  const proxy = JSON.stringify(PROXY_PATH);
  return `(function(){
  var BASE = ${base};
  var PROXY = ${proxy};
  function toProxy(u){
    try {
      var abs = new URL(u, BASE).toString();
      if (abs.indexOf(location.origin + PROXY) === 0) return abs; // already proxied
      return location.origin + PROXY + "?url=" + encodeURIComponent(abs);
    } catch(e){ return u; }
  }
  function isExternalNav(u){
    try { var abs = new URL(u, BASE); return abs.protocol === "http:" || abs.protocol === "https:"; }
    catch(e){ return false; }
  }
  // Anchor + form navigation interception → ask the parent to confirm/navigate.
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    if (!isExternalNav(href)) return;
    e.preventDefault();
    var abs;
    try { abs = new URL(href, BASE).toString(); } catch(_){ return; }
    parent.postMessage({ type: "t3-preview:navigate", url: abs }, "*");
  }, true);
  // Block window.open from spawning real tabs; route to the parent instead.
  window.open = function(u){
    if (u) { try { parent.postMessage({ type: "t3-preview:navigate", url: new URL(u, BASE).toString() }, "*"); } catch(_){} }
    return null;
  };
  // Runtime fetch → proxy.
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function(input, init){
      try {
        var url = typeof input === "string" ? input : (input && input.url);
        if (url) {
          var prox = toProxy(url);
          if (typeof input === "string") input = prox;
          else input = new Request(prox, input);
        }
      } catch(e){}
      return _fetch.call(this, input, init);
    };
  }
  // Runtime XHR → proxy.
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    try { arguments[1] = toProxy(url); } catch(e){}
    return _open.apply(this, arguments);
  };
  // Tell the parent the document is ready + its title (for the address bar).
  function announce(){ try { parent.postMessage({ type: "t3-preview:loaded", url: BASE, title: document.title }, "*"); } catch(e){} }
  if (document.readyState === "complete" || document.readyState === "interactive") announce();
  else document.addEventListener("DOMContentLoaded", announce);
})();`;
}
