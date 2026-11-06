/**
 * Pure preset <-> editor-form mapping.
 *
 * Kept out of the component so the saturation field (and the neutral reset)
 * can be tested without a DOM testing stack.
 */

import type { Preset, PresetInput } from "./types";
import { NEUTRAL } from "./presetCard";

/** Fresh editor state for a new preset. */
export const DEFAULT_PRESET_INPUT: PresetInput = {
  name: "",
  brightness: 50,
  contrast: 50,
  rgb_gains: [1.0, 1.0, 1.0],
  gamma: 1.0,
  vibrance: 50,
  saturation: 50,
  hue_deg: 0,
  color_tag: "",
  tag_shape: "pill",
};

/** Populate the editor form from a stored preset (edit mode). */
export function presetToFormValues(preset: Preset): PresetInput {
  return {
    name: preset.name,
    brightness: preset.brightness,
    contrast: preset.contrast,
    rgb_gains: preset.rgb_gains,
    gamma: preset.gamma,
    vibrance: preset.vibrance,
    saturation: preset.saturation,
    hue_deg: preset.hue_deg,
    color_tag: preset.color_tag ?? "",
    tag_shape: preset.tag_shape ?? "pill",
  };
}

/**
 * Restore every colour slider to its neutral default. Name, ICC selection,
 * tag colour, and capture source are left untouched.
 */
export function resetSliderValues(form: PresetInput): PresetInput {
  return {
    ...form,
    brightness: NEUTRAL.brightness,
    contrast: NEUTRAL.contrast,
    rgb_gains: [1.0, 1.0, 1.0],
    gamma: NEUTRAL.gamma,
    vibrance: NEUTRAL.vibrance,
    saturation: NEUTRAL.saturation,
    hue_deg: 0,
  };
}
