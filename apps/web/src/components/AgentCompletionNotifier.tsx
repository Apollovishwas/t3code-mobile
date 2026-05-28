import { useEffect, useRef } from "react";

import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { notificationPermission, showAgentNotification } from "../notifications";

type StoreState = ReturnType<typeof useStore.getState>;

/** Thread ids that currently have a streaming assistant message. */
function streamingThreadIds(state: StoreState): Set<string> {
  const ids = new Set<string>();
  const environments = state.environmentStateById ?? {};
  for (const environment of Object.values(environments)) {
    const messagesByThread = environment?.messageByThreadId ?? {};
    for (const [threadId, messages] of Object.entries(messagesByThread)) {
      for (const message of Object.values(messages ?? {})) {
        if (message?.role === "assistant" && message.streaming) {
          ids.add(threadId);
          break;
        }
      }
    }
  }
  return ids;
}

/**
 * Fires a browser notification when an agent turn finishes while the tab is
 * backgrounded. Mounted once inside the authenticated app shell; renders
 * nothing. A thread "finishes" when it had a streaming assistant message and no
 * longer does. Gated on the per-device "Agent notifications" setting, which is
 * also where the OS permission is requested (General settings).
 */
export function AgentCompletionNotifier() {
  const enabled = useSettings((s) => s.agentCompletionNotifications);
  // Read inside the non-React store subscription via a ref so toggling the
  // setting takes effect without resubscribing.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, previousState) => {
      if (!enabledRef.current || notificationPermission() !== "granted") {
        return;
      }
      const previous = streamingThreadIds(previousState);
      if (previous.size === 0) {
        return;
      }
      const current = streamingThreadIds(state);
      let finishedCount = 0;
      for (const threadId of previous) {
        if (!current.has(threadId)) {
          finishedCount += 1;
        }
      }
      if (finishedCount === 0 || !document.hidden) {
        return;
      }
      void showAgentNotification("Agent finished", {
        body:
          finishedCount > 1
            ? `${finishedCount} agents finished responding in T3 Code.`
            : "Your agent finished responding in T3 Code.",
        tag: "t3code-agent-finished",
        url: window.location.pathname + window.location.search,
      });
    });

    return unsubscribe;
  }, []);

  return null;
}
