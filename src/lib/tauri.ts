/// Tauri bridge – typed invoke wrappers.
// Mirror the Rust backend commands defined in src-tauri/src/monitor.rs and store.rs.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { DEMO_APPLIED, DEMO_MONITORS, DEMO_PINS, DEMO_PRESETS } from "./demoData";
import type { Locale } from "./i18n";

/** Browser preview only: no Tauri IPC available. */
const isBrowserPreview = () => !isTauri();
import type { ApplyResult, CapturedState, DisplayCapabilities, EnforceEvent, Monitor, MonitorProbe, Preset, PresetInput } from "./types";

/** Sync current UI language ("zh" | "en") with the system tray menu in the Tauri backend. */
export async function setTrayLanguage(lang: Locale): Promise<void> {
  if (isBrowserPreview()) return;
  try {
    await invoke<void>("set_tray_language_cmd", { lang });
  } catch {
    // non-fatal if tray is unavailable
  }
}

/** Fetch the list of connected monitors with their EDID identifiers. */
export async function listMonitors(): Promise<Monitor[]> {
  if (isBrowserPreview()) return DEMO_MONITORS;
  return invoke<Monitor[]>("list_monitors_cmd");
}

/**
 * Show a numbered overlay on each connected monitor to identify them.
 * Returns the 1-based monitor numbers that were shown (may be fewer than
 * connected if some cannot be located via Win32).
 */
export async function identifyMonitors(): Promise<number[]> {
  if (isBrowserPreview()) return [];
  return invoke<number[]>("identify_monitors_cmd");
}

/** Overlay payload for a 1-based monitor number: display name + total. */
export interface IdentifyInfo {
  name: string;
  total: number;
}

/**
 * Resolve overlay info for the 1-based monitor number `n` (same ordering
 * as `identifyMonitors`). Called by identify overlay windows on mount.
 */
export async function getIdentifyInfo(n: number): Promise<IdentifyInfo> {
  return invoke<IdentifyInfo>("identify_info_cmd", { n });
}

// -- Preset store ---------------------------------------------------------

/** Fetch all stored presets. */
export async function listPresets(): Promise<Preset[]> {
  if (isBrowserPreview()) return DEMO_PRESETS;
  return invoke<Preset[]>("list_presets_cmd");
}

/** Create a new preset from user-supplied settings. */
export async function createPreset(input: PresetInput): Promise<Preset> {
  return invoke<Preset>("create_preset_cmd", { input });
}

/** Update an existing preset identified by its UUID. */
export async function updatePreset(
  id: string,
  input: PresetInput,
): Promise<Preset> {
  return invoke<Preset>("update_preset_cmd", { id, input });
}

/** Delete a preset by its UUID.  Returns the deleted preset. */
export async function deletePreset(id: string): Promise<Preset> {
  return invoke<Preset>("delete_preset_cmd", { id });
}

/**
 * Import an ICC profile from the filesystem into the app store.
 * Returns the SHA-256 hex hash of the copied profile.
 */
export async function importIcc(srcPath: string): Promise<string> {
  return invoke<string>("import_icc_cmd", { srcPath });
}

// -- Preset apply ---------------------------------------------------------

/**
 * Apply a colour preset to a target monitor.
 * Returns an ApplyResult indicating which steps succeeded, plus additive
 * per-adjustment outcomes (applied/skipped/failed) when the backend reports
 * them. Legacy fields keep their original meaning.
 */
export async function applyPreset(id: string, targetEdid: string): Promise<ApplyResult> {
  return invoke<ApplyResult>("apply_preset_cmd", { id, targetEdid });
}

/**
 * Reset a monitor to system defaults (identity gamma ramp).
 * ICC associations are left untouched. Writes are verified by
 * read-back: a panel that doesn't reflect the reset surfaces an
 * error instead of reporting false success.
 */
export async function resetMonitor(edidId: string): Promise<ApplyResult> {
  // Tauri v2 maps camelCase JS keys to snake_case Rust params
  // (cf. importIcc/srcPath); the backend expects `edidId`.
  return invoke<ApplyResult>("reset_monitor_cmd", { edidId });
}

/**
 * Read live hardware state for a monitor without changing anything:
 * gamma engine, vibrance/hue levels (when supported), OS ramp peak
 * and whether the ramp is identity. Answers "did it land?".
 */
export async function probeMonitor(edidId: string): Promise<MonitorProbe> {
  return invoke<MonitorProbe>("probe_monitor_cmd", { edidId });
}

/**
 * Probe whether a monitor supports NVIDIA vibrance/hue control.
 * Resolves by EDID; arg name must be camelCase (Tauri v2 convention).
 */
export async function vibranceSupported(edidId: string): Promise<boolean> {
  return invoke<boolean>("vibrance_supported_cmd", { edidId });
}

/**
 * Per-adjustment capability report for a monitor: which backend applies the
 * preset and which adjustments it supports (with reasons when it does not).
 * Resolves by EDID; arg name must be camelCase (Tauri v2 convention).
 */
export async function getDisplayCapabilities(edidId: string): Promise<DisplayCapabilities> {
  return invoke<DisplayCapabilities>("get_display_capabilities", { edidId });
}

// -- Pin enforcement ------------------------------------------------------

/** Pin a preset as the enforced default for its monitor. */
export async function pinPreset(edidId: string, presetId: string): Promise<void> {
  return invoke<void>("pin_preset_cmd", { edidId, presetId });
}

/** Remove enforcement for a monitor (no-op when unpinned). */
export async function unpinMonitor(edidId: string): Promise<void> {
  return invoke<void>("unpin_monitor_cmd", { edidId });
}

/** Map of edid_id -> preset_id for pinned monitors. */
export async function listPins(): Promise<Record<string, string>> {
  if (isBrowserPreview()) return DEMO_PINS;
  return invoke<Record<string, string>>("list_pins_cmd");
}

/** Map of edid_id -> preset_id for last manual applies. Persisted across restarts. */
export async function listApplied(): Promise<Record<string, string>> {
  if (isBrowserPreview()) return DEMO_APPLIED;
  return invoke<Record<string, string>>("list_applied_cmd");
}

/** Set a monitor's display name (empty clears back to default). */
export async function setMonitorName(edidId: string, alias: string): Promise<void> {
  return invoke<void>("set_monitor_name_cmd", { edidId, alias });
}

/** Force a full enforce pass now; returns per-pin outcomes. */
export async function reapplyNow(): Promise<EnforceEvent[]> {
  if (isBrowserPreview()) {
    return DEMO_MONITORS.filter((m) => m.connected).map((m) => ({
      edid_id: m.edid_id,
      preset_id: DEMO_PINS[m.edid_id] ?? "",
      applied: true,
    }));
  }
  return invoke<EnforceEvent[]>("reapply_now_cmd");
}

/** Read NVCP/driver live state into editor-fillable values. */
export async function captureNvcp(edidId: string): Promise<CapturedState> {
  return invoke<CapturedState>("capture_nvcp_cmd", { edidId });
}
