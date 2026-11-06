/**
 * Browser-only demo fixtures.
 *
 * The desktop app always talks to the Rust backend. When the React bundle is
 * opened in a plain browser (dev preview / visual QA) there is no Tauri IPC,
 * so the read commands would throw. These fixtures mirror the Figma
 * "01-App-Shell-Default" reference so the UI can be reviewed pixel-for-pixel.
 *
 * Never used inside Tauri - every consumer checks `isTauri()` first.
 */
import type { Monitor, Preset } from "./types";

export const DEMO_MONITORS: Monitor[] = [
  {
    edid_id: "DEMO-LG-27GP850",
    model: "LG UltraGear 27GP850-B",
    serial: "SN102NTQR4C31842",
    connected: true,
    device_name: "LG UltraGear",
    alias: "",
  },
  {
    edid_id: "DEMO-DELL-U2723QE",
    model: "Dell U2723QE",
    serial: "SNCN0F8X2",
    connected: true,
    device_name: "Dell U2723QE",
    alias: "",
  },
  {
    edid_id: "DEMO-BENQ-PD2700U",
    model: "BenQ PD2700U",
    serial: "SNBQ12345",
    connected: false,
    device_name: "BenQ PD2700U",
    alias: "",
  },
];

const base = {
  icc_hash: "",
  icc_filename: "",
  rgb_gains: [1, 1, 1] as [number, number, number],
  hue_deg: 0,
  saturation: 50,
};

export const DEMO_PRESETS: Preset[] = [
  { ...base, id: "demo-warm-cinema", name: "Movie - Warm Cinema", gamma: 2.2, brightness: 55, contrast: 50, vibrance: 60, color_tag: "#fb923c", tag_shape: "pill" },
  { ...base, id: "demo-srgb-standard", name: "Photo - sRGB Standard", gamma: 1.0, brightness: 50, contrast: 50, vibrance: 50, color_tag: "#38bdf8", tag_shape: "ring" },
  { ...base, id: "demo-low-blue", name: "Night - Low Blue", gamma: 2.4, brightness: 40, contrast: 45, vibrance: 50, color_tag: "#818cf8", tag_shape: "hexagon" },
  { ...base, id: "demo-vibrant", name: "Photo - Vibrant", gamma: 2.2, brightness: 50, contrast: 55, vibrance: 80, color_tag: "#22d3ee", tag_shape: "diamond" },
  {
    ...base,
    id: "demo-photo-pro",
    name: "Photo - Photo Pro",
    gamma: 1.0,
    brightness: 50,
    contrast: 50,
    vibrance: 50,
    icc_hash: "ab12cd34ef56",
    icc_filename: "PhotoPro.icc",
    color_tag: "#f472b6",
    tag_shape: "triangle",
  },
  { ...base, id: "demo-gaming-hdr", name: "Gaming - Gaming HDR", gamma: 2.0, brightness: 60, contrast: 65, vibrance: 70, color_tag: "#60a5fa", tag_shape: null },
  { ...base, id: "demo-custom", name: "Custom - Custom", gamma: 2.2, brightness: 55, contrast: 50, vibrance: 55 },
];

export const DEMO_PINS: Record<string, string> = {
  "DEMO-LG-27GP850": "demo-warm-cinema",
};

export const DEMO_APPLIED: Record<string, string> = {
  "DEMO-LG-27GP850": "demo-warm-cinema",
};
