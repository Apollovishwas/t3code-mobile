/*
 * T3 Code service worker.
 *
 * Scope: notifications only. Intentionally has NO `fetch` handler, so it never
 * caches or intercepts requests — that keeps the Vite dev server and the API/WS
 * proxy working exactly as before. It exists so notifications can be shown from
 * a backgrounded tab and so the app is ready for server-driven Web Push later.
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

// Server-driven Web Push (no server endpoint yet, but the handler is ready).
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "T3 Code", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "T3 Code";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: payload.badge || "/favicon-32x32.png",
    tag: payload.tag || "t3code",
    data: payload.data || { url: "/" },
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
