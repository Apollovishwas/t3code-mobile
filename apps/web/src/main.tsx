import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { installKeyboardInsetTracking } from "./keyboardInset";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

// Track the on-screen keyboard so the composer stays visible above it on iOS.
installKeyboardInsetTracking();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

// Register the notifications service worker (browser only — Electron loads from
// a file shell where service workers don't apply). The worker has no fetch
// handler, so it never intercepts the dev server or API/WS proxying.
if (!isElectron && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("T3 Code service worker registration failed", error);
    });
  });

  // SW -> page bridge for notification clicks. The notificationclick
  // handler posts `{type: "t3code:notification-click", url}` to the
  // focused client; without this listener, the URL was silently dropped
  // and tapping a push notification appeared to do nothing.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "t3code:notification-click") return;
    const targetUrl = typeof data.url === "string" ? data.url : "/";
    if (targetUrl === window.location.pathname + window.location.search) return;
    try {
      router.navigate({ to: targetUrl as never, replace: false });
    } catch {
      // Fall through to a hard navigation if the route isn't typed-known.
      window.location.assign(targetUrl);
    }
  });
}
