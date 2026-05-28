/**
 * Keeps the composer visible above the iOS software keyboard.
 *
 * iOS Safari (and installed PWAs) shrink the *visual* viewport when the
 * keyboard opens but leave the *layout* viewport (dvh/svh/100%) unchanged, so
 * bottom-anchored UI slides behind the keyboard. We measure how far the
 * keyboard overlaps the layout viewport via the VisualViewport API and expose
 * it as the `--keyboard-inset` CSS variable on <html>; the app shell subtracts
 * it from its height (see AppSidebarLayout / index.css).
 *
 * Browsers that instead resize the layout viewport for the keyboard (Android
 * Chrome with interactive-widget=resizes-content) report ~0 overlap here, so
 * this is a no-op there. Desktop and Electron have no software keyboard, so the
 * inset stays 0.
 */
export function installKeyboardInsetTracking(): void {
  const viewport = typeof window !== "undefined" ? window.visualViewport : null;
  if (!viewport) {
    return;
  }

  const root = document.documentElement;
  let frame = 0;

  const update = () => {
    frame = 0;
    // Gap between the layout viewport bottom and the visual viewport bottom —
    // i.e. the height currently obscured by the keyboard (plus any toolbar).
    const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
    root.style.setProperty("--keyboard-inset", `${overlap > 1 ? Math.round(overlap) : 0}px`);
  };

  // VisualViewport fires a burst of events during the keyboard animation;
  // coalesce them to a single write per frame.
  const schedule = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(update);
    }
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  update();
}
