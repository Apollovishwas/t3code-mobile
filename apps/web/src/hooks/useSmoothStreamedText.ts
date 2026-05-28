import { useEffect, useRef, useState } from "react";

/**
 * Smoothly reveals `text` while a message is streaming.
 *
 * The server delivers assistant text in chunks (each update replaces the full
 * message text), which makes streaming feel "steppy". This hook interpolates
 * between those chunks: it keeps a revealed-character cursor that catches up to
 * the latest text over time, so the UI renders a continuous character flow
 * regardless of how chunky the underlying updates are.
 *
 * Behaviour:
 * - Not streaming -> returns the full text immediately (no animation).
 * - Text shrinks/resets (new message reusing the row) -> snaps to the new length.
 * - Reveal speed scales with how far behind we are, so we never lag the server
 *   by more than a moment while keeping a readable minimum cadence.
 *
 * Driven by requestAnimationFrame, which also pauses automatically when the tab
 * is hidden — there's nothing to animate for an unseen tab.
 */
export function useSmoothStreamedText(text: string, isStreaming: boolean): string {
  const [revealedLength, setRevealedLength] = useState(text.length);
  const revealedRef = useRef(text.length);
  const targetRef = useRef(text.length);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  useEffect(() => {
    targetRef.current = text.length;

    // Not streaming: show the whole message at once.
    if (!isStreaming) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      revealedRef.current = text.length;
      setRevealedLength(text.length);
      return;
    }

    // New/replaced message that is shorter than what we already revealed:
    // snap the cursor back so we don't show stale characters.
    if (text.length < revealedRef.current) {
      revealedRef.current = text.length;
      setRevealedLength(text.length);
    }

    const tick = (now: number) => {
      const target = targetRef.current;
      if (revealedRef.current >= target) {
        rafRef.current = null;
        return;
      }
      if (!lastTickRef.current) {
        lastTickRef.current = now;
      }
      const dtMs = Math.min(120, now - lastTickRef.current);
      // Throttle React commits to ~30fps; markdown re-parses on every commit,
      // so revealing per-frame for long messages would be wasteful.
      if (dtMs < 28) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastTickRef.current = now;

      const backlog = target - revealedRef.current;
      const charsPerSecond = Math.max(140, backlog * 12);
      let next = revealedRef.current + Math.max(1, Math.ceil((charsPerSecond * dtMs) / 1000));
      if (next > target) {
        next = target;
      }
      revealedRef.current = next;
      setRevealedLength(next);
      rafRef.current = next < target ? requestAnimationFrame(tick) : null;
    };

    if (rafRef.current == null && revealedRef.current < targetRef.current) {
      lastTickRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [text, isStreaming]);

  if (!isStreaming) {
    return text;
  }
  return text.slice(0, Math.min(revealedLength, text.length));
}

const STREAMING_CARET = "​▏"; // zero-width space + thin block caret

/**
 * Appends a typewriter caret to streamed markdown so there's a visible "typing"
 * cursor at the leading edge of the text. Skipped while inside an unterminated
 * fenced code block, where injecting a glyph would corrupt the fence.
 */
export function withStreamingCaret(text: string): string {
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    return text;
  }
  return text + STREAMING_CARET;
}
