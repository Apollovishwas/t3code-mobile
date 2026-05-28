/**
 * Browser notification helpers for "agent finished" alerts.
 *
 * Prefers the active service worker's `showNotification` (the only path that
 * works while the tab is backgrounded or installed as a PWA), and falls back to
 * the `Notification` constructor when no worker is controlling the page.
 */

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

const NOTIFICATION_ICON = "/icon-192.png";
const NOTIFICATION_BADGE = "/favicon-32x32.png";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermissionState {
  if (!notificationsSupported()) {
    return "unsupported";
  }
  return Notification.permission;
}

/** Requests permission if still undecided; resolves with the resulting state. */
export async function ensureNotificationPermission(): Promise<NotificationPermissionState> {
  if (!notificationsSupported()) {
    return "unsupported";
  }
  if (Notification.permission !== "default") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface AgentNotificationOptions {
  body?: string;
  tag?: string;
  url?: string;
}

export async function showAgentNotification(
  title: string,
  options: AgentNotificationOptions = {},
): Promise<void> {
  if (notificationPermission() !== "granted") {
    return;
  }

  const notificationOptions: NotificationOptions = {
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    tag: options.tag ?? "t3code-agent",
    data: { url: options.url ?? "/" },
    ...(options.body !== undefined ? { body: options.body } : {}),
  };

  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, notificationOptions);
      return;
    }
  } catch {
    // Fall through to the Notification constructor below.
  }

  try {
    const notification = new Notification(title, notificationOptions);
    notification.addEventListener("click", () => {
      window.focus();
      notification.close();
    });
  } catch {
    // Notifications unavailable in this context — ignore.
  }
}
