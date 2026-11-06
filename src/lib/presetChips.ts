/**
 * Deviating-parameter chips for preset pads.
 *
 * Returns one chip per parameter that differs from neutral, so pads show
 * signal instead of noise. An all-neutral preset yields [] and the caller
 * renders a single muted "Neutral" chip (a fresh preset changes nothing
 * until a value moves).
 *
 * Neutrals: gamma 1.0, brightness/contrast 50, rgb_gains [1,1,1],
 * vibrance/saturation 50, hue_deg 0. Float comparisons use a small epsilon;
 * integer fields compare exactly.
 */

import { getCurrentLocale, type Locale } from "./i18n";

export interface ParamChip {
  key: string;
  label: string;
  title: string;
}

export interface ChipParams {
  gamma: number;
  brightness: number;
  contrast: number;
  rgb_gains: [number, number, number];
  vibrance: number;
  saturation: number;
  hue_deg: number;
}

const EPS = 1e-9;

export function deviatingChips(
  p: ChipParams,
  locale: Locale = getCurrentLocale(),
): ParamChip[] {
  const chips: ParamChip[] = [];
  const isZh = locale === "zh";

  if (Math.abs(p.gamma - 1) > EPS) {
    chips.push({
      key: "gamma",
      label: `γ${p.gamma.toFixed(2)}`,
      title: isZh ? `伽马 ${p.gamma.toFixed(2)}` : `Gamma ${p.gamma.toFixed(2)}`,
    });
  }
  if (p.brightness !== 50) {
    chips.push({
      key: "brightness",
      label: `B${p.brightness.toFixed(0)}`,
      title: isZh ? `亮度 ${p.brightness.toFixed(0)}` : `Brightness ${p.brightness.toFixed(0)}`,
    });
  }
  if (p.contrast !== 50) {
    chips.push({
      key: "contrast",
      label: `C${p.contrast.toFixed(0)}`,
      title: isZh ? `对比度 ${p.contrast.toFixed(0)}` : `Contrast ${p.contrast.toFixed(0)}`,
    });
  }
  const channels = ["R", "G", "B"] as const;
  p.rgb_gains.forEach((g, i) => {
    if (Math.abs(g - 1) > EPS) {
      chips.push({
        key: `gain-${channels[i]}`,
        label: `${channels[i]}${g.toFixed(2)}`,
        title: isZh ? `${channels[i]} 增益 ${g.toFixed(2)}` : `${channels[i]} gain ${g.toFixed(2)}`,
      });
    }
  });
  if (p.vibrance !== 50) {
    chips.push({
      key: "vibrance",
      label: `V${p.vibrance.toFixed(0)}`,
      title: isZh ? `数字振动 ${p.vibrance.toFixed(0)}` : `Vibrance ${p.vibrance.toFixed(0)}`,
    });
  }
  if (p.saturation !== 50) {
    chips.push({
      key: "saturation",
      label: `S${p.saturation.toFixed(0)}`,
      title: isZh ? `饱和度 ${p.saturation.toFixed(0)}` : `Saturation ${p.saturation.toFixed(0)}`,
    });
  }
  if (p.hue_deg !== 0) {
    chips.push({
      key: "hue",
      label: `H${p.hue_deg.toFixed(0)}°`,
      title: isZh ? `色相 ${p.hue_deg.toFixed(0)}°` : `Hue ${p.hue_deg.toFixed(0)}°`,
    });
  }
  return chips;
}
