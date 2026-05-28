import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-thread "type the next prompt while the current turn is still running"
 * queue. Stored in `localStorage` so a PWA reopen / hard refresh restores
 * the user's plans, and survives a navigation away from the thread mid-turn.
 *
 * v1 is client-only — the server already keeps turns alive across WS
 * disconnects, so a queued prompt only needs to survive until the user's
 * device reconnects. If we ever want queued prompts to dispatch while the
 * user has fully closed the PWA, we'd lift this to a server contract.
 */

const STORAGE_PREFIX = "t3.promptQueue.v1.";
/** Hard cap to prevent runaway state if a bug puts us in a dispatch loop. */
const MAX_QUEUE_DEPTH = 32;

export interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
  /** ms-epoch when the user enqueued it — used for "queued 2m ago" labels. */
  readonly enqueuedAt: number;
}

interface UsePromptQueueResult {
  readonly items: readonly QueuedPrompt[];
  /** Adds a prompt to the tail. Returns the assigned id. */
  enqueue(text: string): string;
  /** Removes a queued prompt by id (the user changed their mind). */
  remove(id: string): void;
  /** Removes the head and returns it. Used by the auto-dispatcher. */
  dequeue(): QueuedPrompt | null;
  /** Clears the entire queue (user tapped "clear all"). */
  clear(): void;
}

/**
 * Returns the prompt queue for `threadKey` (typically a thread id or, for
 * unsaved drafts, a synthetic draft id). Passing `null` disables persistence
 * — the hook still functions but never reads/writes localStorage, useful for
 * the brief "no active thread" window during navigation.
 */
export function usePromptQueue(threadKey: string | null): UsePromptQueueResult {
  const storageKey = threadKey ? `${STORAGE_PREFIX}${threadKey}` : null;
  const [items, setItems] = useState<readonly QueuedPrompt[]>(() => {
    if (!storageKey || typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Defensive shape-check — old/corrupt entries get filtered out.
      return parsed.filter(
        (entry): entry is QueuedPrompt =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { text?: unknown }).text === "string" &&
          typeof (entry as { enqueuedAt?: unknown }).enqueuedAt === "number",
      );
    } catch {
      return [];
    }
  });
  // Sync state ↔ storage whenever items change (and keep refs for the
  // callbacks below so they don't churn on every render).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      if (items.length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(items));
      }
    } catch {
      // localStorage write can fail in private-browsing — accept the loss.
    }
  }, [storageKey, items]);

  // Reload when the threadKey changes (navigating into a thread that already
  // had queued prompts before we left).
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") {
      setItems([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setItems([]);
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        setItems([]);
        return;
      }
      setItems(
        parsed.filter(
          (entry): entry is QueuedPrompt =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { id?: unknown }).id === "string" &&
            typeof (entry as { text?: unknown }).text === "string" &&
            typeof (entry as { enqueuedAt?: unknown }).enqueuedAt === "number",
        ),
      );
    } catch {
      setItems([]);
    }
  }, [storageKey]);

  const enqueue = useCallback((text: string): string => {
    const trimmed = text.trim();
    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    if (trimmed.length === 0) return id;
    setItems((existing) => {
      if (existing.length >= MAX_QUEUE_DEPTH) return existing;
      return [...existing, { id, text: trimmed, enqueuedAt: Date.now() }];
    });
    return id;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((existing) => existing.filter((item) => item.id !== id));
  }, []);

  const dequeue = useCallback((): QueuedPrompt | null => {
    const head = itemsRef.current[0];
    if (!head) return null;
    setItems((existing) => existing.slice(1));
    return head;
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  return { items, enqueue, remove, dequeue, clear };
}
