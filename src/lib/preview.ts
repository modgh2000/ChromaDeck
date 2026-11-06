/// Simulated preview math – illustrative approximation, NOT the NVCP driver pipeline.
///
/// The NVCP driver applies adjustments at the hardware LUT/gamma-ramp level with
/// per-channel 10-bit curves, gamut-aware clamping, and dithering. This module
/// provides a rough visual preview by processing each pixel through a simplified
/// cascade that approximates the perceptual effect of each control.
///
/// Neutral parameter values (brightness=50, contrast=50, gamma=1.0,
/// rgb_gains=[1,1,1], vibrance=50, saturation=50, hue_deg=0) MUST be exact
/// no-ops.

export interface RgbColor {
  r: number; // 0..1
  g: number;
  b: number;
}

export interface PreviewParams {
  brightness: number;  // 0–100 UI, 50 neutral
  contrast: number;    // 0–100 UI, 50 neutral
  gamma: number;       // 0.3–2.8, 1.0 neutral
  rgb_gains: [number, number, number]; // per-channel multiplier, 1.0 neutral
  vibrance: number;    // 0–100, 50 neutral
  saturation: number;  // 0–100, 50 neutral
  hue_deg: number;     // 0–359, 0 neutral
}

// — Private helpers ———————————————————————————————————————————

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0.0;
  if (d !== 0) {
    if (mx === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else               h = ((r - g) / d + 4) / 6;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) return [v, v, v];
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// — Public API ————————————————————————————————————————————————

/**
 * Apply a preset's simulated adjustments to a single sRGB pixel.
 *
 * Pipeline order:
 *   1. Brightness offset  - add (brightness-50)/100 to every channel
 *   2. Contrast gain      - stretch around 0.5 by contrast/50
 *   3. Gamma              - pow(c, gamma) per channel
 *   4. RGB gains          - per-channel multiplier
 *   5. Vibrance           - saturate/desaturate around luma
 *   6. Saturation         - luma-lerp (Rec.709), 50 = no-op
 *   7. Hue rotation       - HSV round-trip rotation
 *
 * @returns Clamped 0..1 colour.
 */
export function applyPreviewPixel(c: RgbColor, p: PreviewParams): RgbColor {
  let { r, g, b } = c;

  // 1. Brightness offset
  const bOff = (p.brightness - 50) / 100;
  r += bOff;
  g += bOff;
  b += bOff;

  // 2. Contrast gain around 0.5
  const cGain = p.contrast / 50;
  r = (r - 0.5) * cGain + 0.5;
  g = (g - 0.5) * cGain + 0.5;
  b = (b - 0.5) * cGain + 0.5;

  // 3. Gamma (pre-clamp to avoid negative pow)
  r = Math.pow(Math.max(0, r), p.gamma);
  g = Math.pow(Math.max(0, g), p.gamma);
  b = Math.pow(Math.max(0, b), p.gamma);

  // 4. RGB gains
  r *= p.rgb_gains[0];
  g *= p.rgb_gains[1];
  b *= p.rgb_gains[2];

  // 5. Vibrance – push/pull toward/away from luma
  if (p.vibrance !== 50) {
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const factor = 1.0 + ((p.vibrance - 50) / 50) * 0.5;
    r = luma + (r - luma) * factor;
    g = luma + (g - luma) * factor;
    b = luma + (b - luma) * factor;
  }

  // 6. Saturation – luma-lerp (Rec.709). 50 -> factor 1.0 (exact no-op);
  //    0 -> grayscale; 100 -> 2x chroma. Mirrors the Intel matrix control.
  if (p.saturation !== 50) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const factor = p.saturation / 50;
    r = luma + (r - luma) * factor;
    g = luma + (g - luma) * factor;
    b = luma + (b - luma) * factor;
  }

  // 7. Hue rotation via HSV round-trip
  if (p.hue_deg !== 0) {
    const [h, s, v] = rgbToHsv(r, g, b);
    const newHue = (h + p.hue_deg / 360) % 1.0;
    const [nr, ng, nb] = hsvToRgb(newHue, s, v);
    r = nr; g = ng; b = nb;
  }

  // Clamp to valid range
  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}
