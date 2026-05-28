import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MascotAction } from "~/hooks/useMascotAction";
import {
  FRAME_DISPLAY_PX,
  MASCOT_SPRITES,
  spriteCssFor,
} from "./mascotSprites";

/**
 * Tiny "agent is working" mascot — replaces the mobile composer band while a
 * turn is running. Renders a pixel-art monster from craftpix.net's free pack
 * (see `public/mascot/CRAFTPIX_LICENSE.txt`).
 *
 * Behaviour:
 *  - The `action` prop picks which sprite plays (Idle / Walk / Push / Run /
 *    Attack1 / Throw / Climb / Jump / Hurt). The sprite swaps in place
 *    without remounting — only `backgroundImage` + the step keyframe args
 *    change — so the walker / flipper / dust + rock layout stays smooth
 *    across action changes mid-turn.
 *  - Travelling actions (`MASCOT_SPRITES[action].traverses === true`) keep
 *    the walker bouncing wall-to-wall via the `mascot-walk` keyframe with
 *    `animation-direction: alternate`; each iteration flip mirrors the
 *    whole `[dust][char][rock]` row so the character faces its travel.
 *  - Standing actions (Idle / Climb / Jump / Hurt) pause the walker and
 *    let the character stay in place — the sprite still cycles its frames.
 *  - On exit (`exiting` flips true), the walker's current X is snapshotted
 *    and a one-shot CSS transition carries it off-screen in its current
 *    direction — no bounce back.
 *  - Tapping the band shows the composer (and the rest of its chrome) again;
 *    the stop button comes back with it, so an interrupt is one tap away.
 *  - Animations pause when the tab is hidden (battery on mobile).
 *  - `prefers-reduced-motion` swaps the moving art for a quiet "Working…"
 *    pill (no horizontal travel either).
 */

export type MascotCharacterId = "pink" | "owlet" | "dude";

interface ComposerMascotProps {
  /** Which pixel-art monster to render (sprite under `/mascot/`). */
  readonly character: MascotCharacterId;
  /** Which sprite/action to play. See `MASCOT_SPRITES` for the catalogue. */
  readonly action: MascotAction;
  /** When true, plays the exit (off-screen) animation. */
  readonly exiting: boolean;
  /** Tap on the mascot body — show the composer for this turn. */
  readonly onTap: () => void;
}

/** Seconds for one wall-to-wall trip (a full round-trip is 2×). */
const WALK_SECONDS = 3;
/** Must match the parent's `MASCOT_EXIT_MS` so the unmount lines up. */
const EXIT_MS = 600;

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);
  return hidden;
}

/**
 * Pulls the current translateX (in px) out of an element's computed transform.
 * Returns 0 when the transform is `none` or unparseable — defensive default so
 * the exit always starts somewhere sane even if we're called between frames.
 */
function readTranslateX(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  try {
    return new DOMMatrix(t).m41;
  } catch {
    return 0;
  }
}

export function ComposerMascot({ character, action, exiting, onTap }: ComposerMascotProps) {
  const paused = usePageHidden();
  const playState = paused ? "paused" : "running";

  const bandRef = useRef<HTMLDivElement>(null);
  const walkerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  /** Measured travel distance (band width − row width). 0 until first layout. */
  const [travel, setTravel] = useState(0);
  /** +1 = walking right (facing right), -1 = walking left (facing left). */
  const [direction, setDirection] = useState<1 | -1>(1);
  /**
   * Two-phase exit. `pin` paints the walker at its snapshot X with no
   * transition (just freezing the running keyframe in place), then on the
   * next frame we flip to `depart` which applies the transition + off-screen
   * target so the browser interpolates from the snapshot to the wing.
   */
  const [exitState, setExitState] = useState<
    { phase: "pin" | "depart"; from: number; to: number } | null
  >(null);

  const traverses = MASCOT_SPRITES[action].traverses;

  // Measure travel distance once mounted and whenever band/row geometry changes
  // (orientation flip, keyboard show/hide, sidebar collapse on iPad, …).
  useLayoutEffect(() => {
    const band = bandRef.current;
    const row = rowRef.current;
    if (!band || !row) return;
    const recalc = () => {
      const bw = band.getBoundingClientRect().width;
      const rw = row.getBoundingClientRect().width;
      setTravel(Math.max(0, Math.floor(bw - rw)));
    };
    recalc();
    const obs = new ResizeObserver(recalc);
    obs.observe(band);
    obs.observe(row);
    return () => obs.disconnect();
  }, []);

  // Direction-flip tracker: `animation-direction: alternate` fires
  // `animationiteration` at each wall, which is exactly the moment we want
  // the character to about-face. Disabled while exiting (no more flips).
  useEffect(() => {
    const walker = walkerRef.current;
    if (!walker || exiting) return;
    const onIter = (event: AnimationEvent) => {
      if (event.animationName !== "mascot-walk") return;
      setDirection((d) => (d === 1 ? -1 : 1));
    };
    walker.addEventListener("animationiteration", onIter);
    return () => walker.removeEventListener("animationiteration", onIter);
  }, [exiting]);

  // When `exiting` flips true: phase 1 ("pin") snapshots the current
  // translateX and renders it with no transition (freezing the running
  // keyframe in place). Phase 2 ("depart") runs on the next animation frame
  // and applies the transition + off-screen target so the browser
  // interpolates from snapshot → wing.
  useLayoutEffect(() => {
    if (!exiting) {
      setExitState(null);
      return;
    }
    const walker = walkerRef.current;
    const band = bandRef.current;
    const row = rowRef.current;
    if (!walker || !band || !row) return;
    const from = readTranslateX(walker);
    const bandWidth = band.getBoundingClientRect().width;
    const rowWidth = row.getBoundingClientRect().width;
    const to =
      direction === 1
        ? bandWidth + rowWidth + 16
        : -(rowWidth + 16);
    setExitState({ phase: "pin", from, to });
    const raf = requestAnimationFrame(() => {
      setExitState((cur) => (cur ? { ...cur, phase: "depart" } : cur));
    });
    return () => cancelAnimationFrame(raf);
  }, [exiting, direction]);

  // Sprite CSS — `backgroundSize` / `animation` / `--mascot-sheet-end` all
  // come from the per-action config so we don't have to hand-write each one.
  const charSprite = spriteCssFor(action, paused);
  // Dust + rock should only show for actions where the character is actively
  // pushing something across the ground. Idle / Climb / Jump / Hurt — no
  // dust trail, no rock; the character just plays its sprite in place.
  const showDustAndRock = traverses && (action === "push" || action === "walk" || action === "run");
  const dustSprite = spriteCssFor("push", paused); // dust strip is 6-frame, same as push

  return (
    <div
      ref={bandRef}
      role="button"
      tabIndex={0}
      aria-label="Agent is working — tap to show the input"
      onClick={onTap}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onTap();
        }
      }}
      className="relative flex h-16 w-full cursor-pointer select-none items-center overflow-hidden px-3"
    >
      {/* Reduced-motion fallback: a quiet "Working…" pill, no movement. */}
      <div
        className="mx-auto hidden items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground motion-reduce:inline-flex"
        aria-hidden="true"
      >
        <span className="inline-block size-2 rounded-full bg-primary/70" />
        Working…
      </div>

      {/* Walker layer: translates left↔right across the band when traversing,
          or stays pinned at the band centre when standing still. Anchored to
          `bottom-0` so the character's feet sit on the ground line regardless
          of which transform the animation is applying. */}
      <div
        ref={walkerRef}
        className="absolute bottom-0 motion-reduce:hidden"
        style={{
          ...({ "--mascot-travel": `${travel}px` } as React.CSSProperties),
          // When standing still, dock the walker at the horizontal centre of
          // the band — like the character paused mid-walk to think.
          ...(traverses
            ? { left: 0 }
            : { left: "50%", transform: `translateX(-50%)` }),
          ...(exitState
            ? exitState.phase === "pin"
              ? {
                  animation: "none",
                  transform: `translateX(${exitState.from}px)`,
                }
              : {
                  animation: "none",
                  transform: `translateX(${exitState.to}px)`,
                  transition: `transform ${EXIT_MS}ms ease-in`,
                }
            : traverses
              ? {
                  animation: `mascot-walk ${WALK_SECONDS}s linear infinite alternate`,
                  animationPlayState: playState,
                }
              : {}),
        }}
      >
        {/* Flipper layer: mirrors the whole [dust][char][rock] row when
            walking left, so the character faces its travel direction and
            dust/rock swap sides automatically. Not used when standing still. */}
        <div
          ref={rowRef}
          className="flex items-end gap-0"
          style={{
            transform: `scaleX(${traverses ? direction : 1})`,
            transformOrigin: "center",
          }}
        >
          {/* Trailing dust puff — only when pushing/walking/running. */}
          {showDustAndRock ? (
            <div
              aria-hidden="true"
              style={{
                width: `${FRAME_DISPLAY_PX}px`,
                height: `${FRAME_DISPLAY_PX}px`,
                backgroundImage: "url(/mascot/dust_push.png)",
                backgroundRepeat: "no-repeat",
                imageRendering: "pixelated",
                ...({ "--mascot-sheet-end": dustSprite.sheetEnd } as React.CSSProperties),
                backgroundSize: dustSprite.backgroundSize,
                animation: dustSprite.animation,
                animationPlayState: dustSprite.animationPlayState,
              }}
            />
          ) : null}
          {/* The chosen monster character — sprite swaps in place with `action`. */}
          <div
            aria-hidden="true"
            className={showDustAndRock ? "-ml-2" : undefined}
            style={{
              width: `${FRAME_DISPLAY_PX}px`,
              height: `${FRAME_DISPLAY_PX}px`,
              backgroundImage: `url(/mascot/${character}_${action}.png)`,
              backgroundRepeat: "no-repeat",
              imageRendering: "pixelated",
              ...({ "--mascot-sheet-end": charSprite.sheetEnd } as React.CSSProperties),
              backgroundSize: charSprite.backgroundSize,
              animation: charSprite.animation,
              animationPlayState: charSprite.animationPlayState,
            }}
          />
          {/* Rock — only when pushing/walking/running. Static, scaled to 1.5x. */}
          {showDustAndRock ? (
            <img
              src="/mascot/rock.png"
              alt=""
              aria-hidden="true"
              className="-ml-1 mb-1 size-6"
              style={{ imageRendering: "pixelated" }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
