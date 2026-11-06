/// Shared types for ChromaDeck presets and monitors.
// These mirror the Rust structs used in the Tauri backend.

export interface Monitor {
  edid_id: string;
  model: string;
  serial: string;
  connected: boolean;
  device_name: string;
  alias: string; // user display name; empty = use model
}

export interface GammaRamp {
  red: number[]; // 256 values
  green: number[];
  blue: number[];
}

export type TagShape =
  | "pill"
  | "round"
  | "square"
  | "bar"
  | "diamond"
  | "hexagon"
  | "triangle"
  | "ring";

export interface Preset {
  id: string;
  name: string;
  icc_hash: string;
  icc_filename: string;
  brightness: number; // 0-100 UI, 50 neutral
  contrast: number; // 0-100 UI, 50 neutral
  rgb_gains: [number, number, number]; // per-channel multiplier
  gamma: number; // 0.3 - 2.8 (NVCP range, 1.0 neutral)
  vibrance: number; // 0 - 100, 50 neutral
  saturation: number; // 0 - 100, 50 neutral
  hue_deg: number; // 0 - 359 degrees
  color_tag?: string; // #rrggbb hex or empty/undefined for untagged
  tag_shape?: TagShape | null; // marker shape; backend may send null = pill
}

export interface PresetInput {
  name: string;
  icc_path?: string;
  brightness: number;
  contrast: number;
  rgb_gains: [number, number, number];
  gamma: number;
  vibrance: number;
  saturation: number; // 0 - 100, 50 neutral
  hue_deg: number;
  color_tag?: string; // #rrggbb hex or empty for untagged
  tag_shape?: TagShape; // marker shape; empty = pill
}

export type AdjustmentStatus = "applied" | "skipped" | "failed";

/** One adjustment's outcome from an apply attempt. */
export interface AdjustmentOutcome {
  adjustment: string;
  status: AdjustmentStatus;
  /** False when the backend accepted a write but did not read the panel back. */
  verified: boolean;
  reason?: string;
}

export interface ApplyResult {
  icc_applied: boolean;
  gamma_applied: boolean;
  vibrance_applied: boolean;
  error?: string;
  /**
   * Per-adjustment detail (additive; absent on legacy responses).
   * Order follows apply order: ICC, gamma family, saturation, vibrance, hue.
   */
  adjustments?: AdjustmentOutcome[];
}

export interface EnforceEvent {
  edid_id: string;
  preset_id: string;
  applied: boolean;
  error?: string;
}

export interface CapturedState {
  brightness: number; // 0-100 UI
  contrast: number; // 0-100 UI
  gamma: number; // exponent
  vibrance: number;
  hue_deg: number;
}

export type CapabilityStatus = "supported" | "approximate" | "unsupported";

/** One adjustment's support verdict for a display. */
export interface DisplayCapability {
  adjustment: string;
  status: CapabilityStatus;
  reason?: string; // present for unsupported/approximate
}

/** Per-display capability report returned by `get_display_capabilities`. */
export interface DisplayCapabilities {
  backend_id: string; // "nvapi" | "intel" | "gdi"
  backend_label: string; // human-readable backend name
  adjustments: DisplayCapability[];
}

export interface MonitorProbe {
  engine: string; // legacy coarse class: "nvapi" | "gdi"
  backend_id: string; // real backend: "nvapi" | "intel" | "gdi"
  vibrance_supported: boolean;
  vibrance: number | null;
  hue: number | null;
  // Peak of the live colour ramp/LUT (0..1). Intel reports its pixtx 1D LUT.
  ramp_peak: number | null;
  // Whether that ramp/LUT is linear identity. Intel reports its pixtx 1D LUT.
  ramp_identity: boolean | null;
}
