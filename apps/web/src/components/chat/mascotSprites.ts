/**
 * Per-action sprite configuration for the working mascot. Each entry pins
 * the strip's frame count, the per-loop duration, and whether the character
 * should keep walking wall-to-wall (`traverses: true`) or stand still
 * (`traverses: false`, used for Idle / Climb / Jump / Hurt).
 *
 * Sprites live at `public/mascot/{character}_{action}.png` and are 32px tall
 * source, rendered at 1.5x scale (= 48px on screen) via the
 * `mascot-sprite-step` keyframe + a `--mascot-sheet-end` CSS var pointing at
 * the last frame's negative X offset.
 */

import type { MascotAction } from "~/hooks/useMascotAction";

/** Source pixel size of one frame (all strips share this). */
export const FRAME_SOURCE_PX = 32;
/** Display scale — pixel-art rendered at 1.5x looks bigger but still crisp. */
export const FRAME_SCALE = 1.5;
/** Rendered frame size in CSS px. */
export const FRAME_DISPLAY_PX = FRAME_SOURCE_PX * FRAME_SCALE;

export interface MascotSpriteConfig {
  readonly frames: number;
  /** Seconds for one full sprite loop. */
  readonly loopSeconds: number;
  /** Should the walker bounce wall-to-wall while this action plays? */
  readonly traverses: boolean;
}

export const MASCOT_SPRITES: Record<MascotAction, MascotSpriteConfig> = {
  push: { frames: 6, loopSeconds: 0.6, traverses: true },
  walk: { frames: 6, loopSeconds: 0.6, traverses: true },
  run: { frames: 6, loopSeconds: 0.4, traverses: true },
  attack1: { frames: 4, loopSeconds: 0.4, traverses: true },
  throw: { frames: 4, loopSeconds: 0.5, traverses: true },
  idle: { frames: 4, loopSeconds: 0.9, traverses: false },
  climb: { frames: 4, loopSeconds: 0.7, traverses: false },
  jump: { frames: 8, loopSeconds: 0.7, traverses: false },
  hurt: { frames: 4, loopSeconds: 0.4, traverses: false },
};

/**
 * Tuple form for an animation-frame strip when applied as a CSS background.
 *  - `sheetWidth` — pixel width of the displayed strip (frames × frame px).
 *  - `endOffset` — negative pixel offset of the last frame, fed into the
 *    `--mascot-sheet-end` CSS variable used by `mascot-sprite-step`.
 *  - `animation` — full `animation` shorthand including the matching
 *    `steps(N)` timing function.
 */
export function spriteCssFor(action: MascotAction, paused: boolean): {
  backgroundSize: string;
  sheetEnd: string;
  animation: string;
  animationPlayState: "paused" | "running";
} {
  const cfg = MASCOT_SPRITES[action];
  const sheetWidthPx = cfg.frames * FRAME_DISPLAY_PX;
  return {
    backgroundSize: `${sheetWidthPx}px ${FRAME_DISPLAY_PX}px`,
    sheetEnd: `-${sheetWidthPx}px`,
    animation: `mascot-sprite-step ${cfg.loopSeconds}s steps(${cfg.frames}) infinite`,
    animationPlayState: paused ? "paused" : "running",
  };
}
