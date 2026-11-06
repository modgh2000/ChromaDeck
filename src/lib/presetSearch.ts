/**
 * Preset library search + category filtering - pure helpers used by the
 * presets carousel header.
 *
 * Matching rules:
 * - Case-insensitive.
 * - The query is split on whitespace; every token must appear somewhere in
 *   the preset name (which already contains the category prefix, e.g.
 *   "Movie - Warm Cinema"). Order does not matter.
 * - An empty or whitespace-only query matches everything.
 * - A category filter of ALL_CATEGORIES matches every preset; NO_CATEGORY
 *   matches presets whose name has no "Category - " prefix.
 */

import { splitCategory } from "./presetCard";
import type { Preset } from "./types";

/** Sentinel: no category filter applied. */
export const ALL_CATEGORIES = "__all__";
/** Sentinel: only presets without a category prefix. */
export const NO_CATEGORY = "__none__";

/** Distinct categories currently in the library, sorted for display. */
export function presetCategories(presets: Preset[]): string[] {
  const categories = new Set<string>();
  for (const preset of presets) {
    const { category } = splitCategory(preset.name);
    if (category) categories.add(category);
  }
  return [...categories].sort((a, b) => a.localeCompare(b));
}

/** True when at least one preset has no category prefix. */
export function hasUncategorisedPresets(presets: Preset[]): boolean {
  return presets.some((preset) => !splitCategory(preset.name).category);
}

export function filterPresets(
  presets: Preset[],
  query: string,
  category: string = ALL_CATEGORIES,
): Preset[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return presets.filter((preset) => {
    const { category: presetCategory } = splitCategory(preset.name);
    if (category === NO_CATEGORY) {
      if (presetCategory) return false;
    } else if (category !== ALL_CATEGORIES && presetCategory !== category) {
      return false;
    }
    if (tokens.length === 0) return true;
    const name = preset.name.toLowerCase();
    return tokens.every((token) => name.includes(token));
  });
}
