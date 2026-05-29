import { useEffect, useRef } from "react";

import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { notificationPermission, showAgentNotification } from "../notifications";

type StoreState = ReturnType<typeof useStore.getState>;

interface StreamingThreadEntry {
  readonly threadId: string;
  readonly environmentId: string;
}

/** Thread ids that currently have a streaming assistant message,
 *  paired with the environment they belong to so we can build the
 *  correct deep-link URL when they finish. */
function streamingThreads(state: StoreState): Map<string, StreamingThreadEntry> {
  const entries = new Map<string, StreamingThreadEntry>();
  const environments = state.environmentStateById ?? {};
  for (const [environmentId, environment] of Object.entries(environments)) {
    const messagesByThread = environment?.messageByThreadId ?? {};
    for (const [threadId, messages] of Object.entries(messagesByThread)) {
      for (const message of Object.values(messages ?? {})) {
        if (message?.role === "assistant" && message.streaming) {
          entries.set(threadId, { threadId, environmentId });
          break;
        }
      }
    }
  }
  return entries;
}

function threadDeepLink(entry: StreamingThreadEntry): string {
  return `/${encodeURIComponent(entry.environmentId)}/${encodeURIComponent(entry.threadId)}`;
}

/**
 * Fires a browser notification when an agent turn finishes while the tab is
 * backgrounded. Mounted once inside the authenticated app shell; renders
 * nothing.
 *
 * Each finished thread carries its own deep-link URL (`/env/thread`) so
 * tapping the notification takes you to *that* thread, not the page you
 * happened to be looking at when it fired. The SW message bridge in
 * main.tsx routes the URL through TanStack Router. With 2+ agents
 * running the previously-current behaviour took users to the wrong
 * thread.
 *
 * Gated on the per-device "Agent notifications" setting + the OS-level
 * Notification.permission grant.
 */
export function AgentCompletionNotifier() {
  const enabled = useSettings((s) => s.agentCompletionNotifications);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, previousState) => {
      if (!enabledRef.current || notificationPermission() !== "granted") {
        return;
      }
      const previous = streamingThreads(previousState);
      if (previous.size === 0) {
        return;
      }
      const current = streamingThreads(state);
      const finished: StreamingThreadEntry[] = [];
      for (const [threadId, entry] of previous) {
        if (!current.has(threadId)) {
          finished.push(entry);
        }
      }
      if (finished.length === 0 || !document.hidden) {
        return;
      }
      // When multiple threads finish in the same store update (rare but
      // possible), pick the most recent one as the click target — that
      // matches the visible notification, which is also one entry per
      // tag. The body distinguishes single vs multi-finish so the user
      // knows others are also done.
      const primary = finished[finished.length - 1]!;
      void showAgentNotification("Agent finished", {
        body:
          finished.length > 1
            ? `${finished.length} agents finished responding in T3 Code.`
            : "Your agent finished responding in T3 Code.",
        tag: "t3code-agent-finished",
        url: threadDeepLink(primary),
      });
    });

    return unsubscribe;
  }, []);

  return null;
}
