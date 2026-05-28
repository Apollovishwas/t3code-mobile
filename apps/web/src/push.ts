/**
 * Client-side Web Push subscription management.
 *
 * Pairs with the server's `/api/push/*` routes and the `push` handler in
 * `public/sw.js`. Web Push is the only notification path that reaches a
 * backgrounded/suspended iOS PWA, where foreground JS is frozen.
 */

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/**
 * Subscribes this device for server-sent push and registers the subscription
 * with the server. Safe to call repeatedly (reuses an existing subscription).
 * Returns whether a subscription is now registered.
 */
export async function enablePushSubscription(): Promise<boolean> {
  if (!pushSupported()) {
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const keyResponse = await fetch("/api/push/public-key");
    if (!keyResponse.ok) {
      return false;
    }
    const { publicKey } = (await keyResponse.json()) as { publicKey?: string };
    if (!publicKey) {
      return false;
    }

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    return response.ok;
  } catch (error) {
    console.warn("Failed to enable push subscription", error);
    return false;
  }
}

/** Unregisters this device's push subscription on the server and the browser. */
export async function disablePushSubscription(): Promise<void> {
  if (!pushSupported()) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      return;
    }
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  } catch (error) {
    console.warn("Failed to disable push subscription", error);
  }
}
