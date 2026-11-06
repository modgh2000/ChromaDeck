/**
 * ChromaDeck motion/animation utilities.
 *
 * Thin helpers for stagger entrance, reduced-motion detection,
 * CSS custom-property generation, masked-reveal/value-swap helpers,
 * and entrance replay. No animation engine — all motion is CSS-driven
 * (transform + opacity only).
 */

/* — Stagger-once flag ——————————————————————————————————————————— */

const STAGGER_KEY = "__chromadeck_stagger_done";

/**
 * Consume the once-per-session stagger allowance.
 * Returns `true` only once per app lifetime; `false` on subsequent calls
 * so that stagger animation plays on initial load only.
 */
export function consumeStagger(): boolean {
  if (typeof window === "undefined") return true;
  if ((window as any)[STAGGER_KEY]) return false;
  (window as any)[STAGGER_KEY] = true;
  return true;
}

/** Reset stagger flag (useful in tests). */
export function resetStagger(): void {
  if (typeof window !== "undefined") {
    delete (window as any)[STAGGER_KEY];
  }
}

/* — Reduced-motion preference ——————————————————————————————————— */

/** Live check of prefers-reduced-motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

/** Eager snapshot at import time (no runtime overhead in hot paths). */
export const REDUCED_MOTION: boolean =
  typeof window !== "undefined"
    ? prefersReducedMotion()
    : false;

/* — shouldAnimate — global gate ————————————————————————————————— */

/**
 * Returns `false` when the user prefers reduced motion, so callers can skip
 * adding animated CSS classes. Also returns `false` in SSR/test envs where
 * `window` is absent.
 */
export function shouldAnimate(): boolean {
  if (typeof window === "undefined") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* — CSS custom-property helpers ————————————————————————————————— */

/**
 * Returns a CSS custom-property declaration for stagger animation delay.
 * Usage: `style={staggerCss(i)}` on an element with class `enter-stagger`.
 * Default baseMs is 60ms (not 80ms) so the cap of 5 cards x 60ms = 300ms
 * total stagger fits well within the --motion-std 350ms glide window.
 */
export function staggerCss(index: number, baseMs = 60): Record<string, string> {
  return { "--stagger-ms": `${index * baseMs}ms` };
}

/**
 * Returns the CSS class and inline style for a masked-reveal entrance.
 * On reduced-motion systems only the class is returned (no animation).
 *
 * Usage:
 *   <h1 className={maskedRevealClass(40).cls} style={maskedRevealClass(40).style}>
 */
export function maskedRevealClass(delayMs = 0): {
  cls: string;
  style: Record<string, string>;
} {
  const cls = "enter-reveal";
  const style: Record<string, string> = { "--reveal-delay": `${delayMs}ms` };
  return { cls, style };
}

/**
 * Returns the CSS class for a value-swap crossfade.
 * On reduced-motion systems returns an empty string (instant swap).
 */
export function valueSwapClass(): string {
  return shouldAnimate() ? "value-swap" : "";
}

/* — Entrance replay (window re-show) ————————————————————————————— */

/**
 * Replay the staged load animation on the existing DOM without remounting.
 *
 * The main window is hidden – not destroyed – when closed to the tray, so
 * mount-time CSS animations would otherwise play once per app lifetime.
 * The backend emits `window-shown` every time the window is re-shown; the
 * frontend answers with this function, which force-restarts the entrance
 * animations in place. State, scroll position, and open dialogs are
 * preserved (only the `animation` inline override is touched, then
 * cleared so the stylesheet value applies again).
 *
 * **Card limit**: only the first 6 cards are restarted to avoid a
 * performance spike on large libraries.
 */
export function replayEntrance(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (prefersReducedMotion()) return;

  const restart = (el: HTMLElement) => {
    el.style.animation = "none";
    // Force a reflow so the override above commits; clearing it then
    // restarts the stylesheet animation from frame 0 with its own delay.
    void el.offsetHeight;
    el.style.animation = "";
  };

  // Shell regions + sidebar content + monitor rows: their entrance classes
  // and stagger variables are always present, so a restart suffices.
  const regions = document.querySelectorAll<HTMLElement>(
    ".shell-enter, .sidebar-content-enter, .monitor-row-enter",
  );
  regions.forEach(restart);

  // Preset cards: the `enter-stagger` class is only attached on first load
  // (see consumeStagger), so re-attach it with per-card delays before
  // restarting. Cap to 6 cards to avoid performance spike.
  const cards = document.querySelectorAll<HTMLElement>(".preset-deck > *");
  const capped = Math.min(cards.length, 6);
  for (let i = 0; i < capped; i++) {
    const card = cards[i];
    card.classList.add("enter-stagger");
    card.style.setProperty("--stagger-ms", `${i * 60}ms`);
    restart(card);
  }
}
