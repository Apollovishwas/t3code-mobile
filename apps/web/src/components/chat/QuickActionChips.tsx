import { useCallback, useEffect, useState } from "react";

/**
 * Horizontal row of pre-canned tap chips rendered above the composer on
 * mobile. Each chip is one thumb-tap that fills the composer with a stock
 * phrase and immediately submits — collapsing the "type ten characters to
 * approve" friction that's the #1 mobile-coding-agent complaint.
 *
 * Visibility rules (the caller decides; this component is dumb):
 *  - Only on mobile (the desktop composer doesn't need this).
 *  - Only when the composer card is visible (hidden behind mascot →
 *    hidden chips, naturally).
 *  - Only when the prompt field is empty (chips don't crowd typing).
 *  - Only when the agent is idle (sending-while-running fails today;
 *    once prompt queueing lands we'll change this guard).
 *
 * Per-device on/off lives in `localStorage` (key: `t3.quickChips.enabled`)
 * to avoid the cost of a new server-side ClientSettings field for a
 * UI-only toggle — see `useQuickChipsEnabled` below.
 */

const STORAGE_KEY = "t3.quickChips.enabled";

export interface QuickActionChip {
  readonly label: string;
  /** Text that lands in the composer and gets submitted on tap. */
  readonly text: string;
}

/** Default chip set — chosen for the highest-frequency mobile replies. */
export const DEFAULT_QUICK_ACTION_CHIPS: readonly QuickActionChip[] = [
  { label: "Yes, proceed", text: "Yes, proceed." },
  { label: "Show the plan", text: "Show me the plan first." },
  { label: "Run the tests", text: "Run the tests." },
  { label: "Continue", text: "Continue." },
  { label: "Looks good", text: "Looks good, ship it." },
  { label: "Explain", text: "Explain what you just did and why." },
  { label: "Undo", text: "Undo that change." },
  { label: "Try again", text: "Try that again with a different approach." },
];

/**
 * Tiny hook returning the per-device on/off flag with a setter. Stored in
 * `localStorage` so each phone/iPad picks independently and survives PWA
 * reinstall. Defaults to ON.
 */
export function useQuickChipsEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const update = useCallback((next: boolean) => {
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // localStorage can throw in private-browsing on some iOS versions;
      // we just keep the in-memory value and move on.
    }
  }, []);
  // Cross-tab sync — another tab toggling the setting reflects here too.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setEnabled(event.newValue === null ? true : event.newValue === "true");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  return [enabled, update];
}

interface QuickActionChipsProps {
  readonly chips?: readonly QuickActionChip[];
  /** Called with the chip's `text`. Caller fills the composer + submits. */
  readonly onSend: (text: string) => void;
}

export function QuickActionChips({
  chips = DEFAULT_QUICK_ACTION_CHIPS,
  onSend,
}: QuickActionChipsProps) {
  return (
    <div
      // Horizontally scrollable strip — chips can overflow the viewport
      // and the user can swipe to reveal more, like iOS Messages reactions.
      className="mb-2 -mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:hidden"
      role="toolbar"
      aria-label="Quick replies"
    >
      {chips.map((chip) => (
        <button
          key={chip.label}
          type="button"
          // 44pt tap target per iOS HIG; rounded-full + small border looks
          // distinct from the composer's input affordance.
          className="shrink-0 cursor-pointer select-none whitespace-nowrap rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted active:bg-muted"
          onPointerDown={(event) => event.preventDefault() /* keep keyboard down */}
          onClick={() => onSend(chip.text)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
