/** Pure validation logic - testable without Tauri runtime. */
import type { PresetInput } from "./types";
import { getCurrentLocale, type Locale } from "./i18n";

/** Shapes the tag marker can take. */
export const TAG_SHAPES = [
  "pill",
  "round",
  "square",
  "bar",
  "diamond",
  "hexagon",
  "triangle",
  "ring",
] as const;

export interface ValidationErrors {
  name?: string;
  gamma?: string;
  brightness?: string;
  contrast?: string;
  rgb_gains?: string;
  icc_path?: string;
  vibrance?: string;
  saturation?: string;
  hue_deg?: string;
  nvcp?: string;
  color_tag?: string;
  tag_shape?: string;
}

const VALIDATION_MESSAGES: Record<Locale, Record<keyof ValidationErrors, string>> = {
  en: {
    name: "Name is required",
    gamma: "Gamma must be between 0.3 and 2.8",
    brightness: "Brightness must be between 0 and 100",
    contrast: "Contrast must be between 0 and 100",
    rgb_gains: "RGB gains must be non-negative values",
    icc_path: "Invalid ICC profile path",
    vibrance: "Vibrance must be between 0 and 100",
    saturation: "Saturation must be between 0 and 100",
    hue_deg: "Hue must be between 0 and 359",
    nvcp: "Failed to capture NVCP state",
    color_tag: "Color tag must be a hex color like #rrggbb or empty",
    tag_shape: "Tag shape must be pill, round, square, bar, diamond, hexagon, triangle, ring or empty",
  },
  zh: {
    name: "预设名称不能为空",
    gamma: "伽马 (Gamma) 必须在 0.3 到 2.8 之间",
    brightness: "亮度必须在 0 到 100 之间",
    contrast: "对比度必须在 0 到 100 之间",
    rgb_gains: "RGB 增益必须为非负数",
    icc_path: "无效的 ICC 配置文件路径",
    vibrance: "数字振动必须在 0 到 100 之间",
    saturation: "饱和度必须在 0 到 100 之间",
    hue_deg: "色相必须在 0 到 359 之间",
    nvcp: "捕获 NVIDIA 控制面板状态失败",
    color_tag: "颜色标签必须为 #rrggbb 格式的十六进制颜色或留空",
    tag_shape: "标签形状必须为预设形状之一或留空",
  },
};

/** Validate a partial PresetInput and return per-field error strings. */
export function validatePreset(
  input: Partial<PresetInput>,
  locale: Locale = getCurrentLocale(),
): ValidationErrors {
  const errors: ValidationErrors = {};
  const msg = VALIDATION_MESSAGES[locale] ?? VALIDATION_MESSAGES.en;

  if (input.name !== undefined) {
    if (input.name.trim().length === 0) {
      errors.name = msg.name;
    }
  }

  if (input.gamma !== undefined) {
    if (typeof input.gamma !== "number" || input.gamma < 0.3 || input.gamma > 2.8) {
      errors.gamma = msg.gamma;
    }
  }

  if (input.brightness !== undefined) {
    if (typeof input.brightness !== "number" || input.brightness < 0 || input.brightness > 100) {
      errors.brightness = msg.brightness;
    }
  }

  if (input.contrast !== undefined) {
    if (typeof input.contrast !== "number" || input.contrast < 0 || input.contrast > 100) {
      errors.contrast = msg.contrast;
    }
  }

  if (input.rgb_gains !== undefined) {
    if (
      !Array.isArray(input.rgb_gains) ||
      input.rgb_gains.length !== 3 ||
      input.rgb_gains.some((v) => typeof v !== "number" || v < 0)
    ) {
      errors.rgb_gains = msg.rgb_gains;
    }
  }

  if (input.vibrance !== undefined) {
    if (typeof input.vibrance !== "number" || input.vibrance < 0 || input.vibrance > 100) {
      errors.vibrance = msg.vibrance;
    }
  }

  if (input.saturation !== undefined) {
    if (typeof input.saturation !== "number" || input.saturation < 0 || input.saturation > 100) {
      errors.saturation = msg.saturation;
    }
  }

  if (input.hue_deg !== undefined) {
    if (typeof input.hue_deg !== "number" || input.hue_deg < 0 || input.hue_deg > 359) {
      errors.hue_deg = msg.hue_deg;
    }
  }

  if (input.color_tag !== undefined) {
    if (input.color_tag !== "" && !/^#[0-9a-fA-F]{6}$/.test(input.color_tag)) {
      errors.color_tag = msg.color_tag;
    }
  }

  if (input.tag_shape !== undefined) {
    if (!(TAG_SHAPES as readonly string[]).includes(input.tag_shape)) {
      errors.tag_shape = msg.tag_shape;
    }
  }

  return errors;
}

/** Full form validation before save. Returns true if valid, populates errors. */
export function validatePresetForm(
  input: PresetInput,
  errors: ValidationErrors,
  locale: Locale = getCurrentLocale(),
): boolean {
  // Check every field
  const all = validatePreset(
    {
      name: input.name,
      gamma: input.gamma,
      brightness: input.brightness,
      contrast: input.contrast,
      rgb_gains: input.rgb_gains,
      vibrance: input.vibrance,
      saturation: input.saturation,
      hue_deg: input.hue_deg,
      color_tag: input.color_tag,
      tag_shape: input.tag_shape,
    },
    locale,
  );

  Object.assign(errors, all);

  return Object.keys(errors).length === 0;
}
