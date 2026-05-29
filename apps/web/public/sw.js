/*
 * T3 Code service worker.
 *
 * Scope: notifications only. Intentionally has NO `fetch` handler, so it never
 * caches or intercepts requests — that keeps the Vite dev server and the API/WS
 * proxy working exactly as before. It exists so notifications can be shown from
 * a backgrounded tab and so the app is ready for server-driven Web Push.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Page -> SW bridge: lets the app show a notification via the worker.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "t3code:notify" || !data.title) {
    return;
  }
  event.waitUntil(self.registration.showNotification(data.title, data.options || {}));
});

// Server-driven Web Push.
//
// The server's PushPayloadSchema puts `url` at the top level (along with
// title/body/tag/icon/badge). We fall back through nested `data.url` and
// then "/" for forward-compat with any future payload shape, but the
// primary read site is now correct: a per-thread URL coming off the
// reactor actually lands in `notification.data.url`.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "T3 Code", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "T3 Code";
  const resolvedUrl =
    (typeof payload.url === "string" && payload.url) ||
    (payload.data && typeof payload.data.url === "string" && payload.data.url) ||
    "/";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: payload.badge || "/favicon-32x32.png",
    tag: payload.tag || "t3code",
    data: { ...(payload.data || {}), url: resolvedUrl },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing tab (or open one) when a notification is clicked.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          // Post-message lands in main.tsx's `navigator.serviceWorker`
          // listener which calls `router.navigate(...)`. Without that
          // listener — historically — the URL was silently dropped.
          client.postMessage({ type: "t3code:notification-click", url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});

// Self-heal expired push subscriptions. Browsers rotate the subscription
// after 30–90 days; without this listener the server keeps pushing to a
// stale endpoint and the user assumes notifications are broken. The new
// subscription is reported to the server so the next push lands.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const oldSubscription = event.oldSubscription;
        // Refresh using the same applicationServerKey when available; fall back
        // to the public key we cached in the previous subscription.
        const applicationServerKey =
          (event.newSubscription && event.newSubscription.options.applicationServerKey) ||
          (oldSubscription && oldSubscription.options.applicationServerKey);
        if (!applicationServerKey) return;
        const subscription =
          event.newSubscription ||
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          }));
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: subscription.toJSON(),
            // The reason field helps the server distinguish a fresh
            // browser-initiated subscribe from a renewal — useful for
            // metrics later.
            reason: "subscription-change",
          }),
        });
      } catch (err) {
        // Best-effort — swallow errors so the SW doesn't keep retrying
        // forever and burning battery.
        console.warn("[t3 sw] subscription refresh failed:", err);
      }
    })(),
  );
});
