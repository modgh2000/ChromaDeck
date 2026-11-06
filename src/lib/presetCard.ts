/**
 * PresetCard helpers – neutral constants, formatting, category splitting.
 *
 * Neutral values verified against:
 *   - src/lib/preview.ts:9,19-22
 *   - src/lib/presetChips.ts:29,34,41,48,65
 *   - src/components/PresetEditor.tsx:25-30
 *   - src-tauri/src/store.rs:10 (fn default_vibrance() -> f64 { 50.0 })
 */

/** Epsilon for gamma float comparison. */
export const GAMMA_EPS = 1e-9;

/** All-stat neutrals – gamma uses EPS; integers compare exactly. */
export const NEUTRAL: Record<string, number> = {
  gamma: 1.0,
  brightness: 50,
  contrast: 50,
  vibrance: 50,
  saturation: 50,
} as const;

/** Stat keys in display order. */
export const STAT_KEYS = [
  "gamma",
  "brightness",
  "contrast",
  "vibrance",
  "saturation",
] as const;

/** Human-readable labels for stat tiles. */
export const STAT_LABELS: Record<string, string> = {
  gamma: "Gamma",
  brightness: "Brightness",
  contrast: "Contrast",
  vibrance: "Vibrance",
  saturation: "Saturation",
};

/**
 * Check whether a stat value is at its neutral (default) value.
 * Gamma uses epsilon comparison; integers compare exactly.
 */
export function isNeutral(key: string, value: number): boolean {
  if (key === "gamma") return Math.abs(value - NEUTRAL[key]) < GAMMA_EPS;
  return value === NEUTRAL[key];
}

/**
 * Format a gamma value to 2 decimal places.
 * Uses trailing-zeros preserving format (never drops ".00").
 */
export function formatGamma(gamma: number): string {
  return gamma.toFixed(2);
}

/**
 * Format an integer stat (brightness, contrast, vibrance) with no decimals.
 */
export function formatInt(value: number): string {
  return value.toFixed(0);
}

/**
 * Format a stat value for display. Gamma gets 2 decimals, others are integers.
 */
export function formatStat(key: string, value: number): string {
  if (key === "gamma") return formatGamma(value);
  return formatInt(value);
}

/**
 * Split a preset name into (category, title) on the first " - " separator.
 * - "Movie - Warm" -> { category: "Movie", title: "Warm" }
 * - "Warm" -> { category: undefined, title: "Warm" }
 * - "A - B - C" -> { category: "A", title: "B - C" } (first separator only)
 */
export function splitCategory(name: string): { category?: string; title: string } {
  const idx = name.indexOf(" - ");
  if (idx === -1) return { category: undefined, title: name };
  return {
    category: name.slice(0, idx),
    title: name.slice(idx + 3),
  };
}

/**
 * Compose a stored preset name from a category and a title, the inverse of
 * `splitCategory`. Both parts are trimmed; missing parts are omitted.
 * - ("Movie", "Warm") -> "Movie - Warm"
 * - ("", "Warm") -> "Warm"
 * - ("Movie", "") -> "Movie"
 */
export function joinCategory(category: string, title: string): string {
  const trimmedCategory = category.trim();
  const trimmedTitle = title.trim();
  if (!trimmedCategory) return trimmedTitle;
  if (!trimmedTitle) return trimmedCategory;
  return `${trimmedCategory} - ${trimmedTitle}`;
}
