// --- Preset enforcer: resident drift-check + reapply -------------------

use std::collections::HashMap;
use serde::Serialize;

/// Outcome of one enforced (or skipped) pin.
#[derive(Debug, Clone, Serialize)]
pub struct EnforceEvent {
    pub edid_id: String,
    pub preset_id: String,
    pub applied: bool,
    pub error: Option<String>,
}

/// Hardware state reads, isolated for testability.
pub trait StateReader {
    fn read_lut(&self, edid_id: &str) -> Result<[u16; 768], String>;
    fn read_color(&self, edid_id: &str) -> Result<(f64, f64), String>;
    /// Read NVCP registry B/C/G channel means (internal scale, 80-120).
    /// Returns `None` when NVAPI or registry is unreachable.
    fn read_nvcp_registry(&self, edid_id: &str) -> Option<(f64, f64, f64)>;
    /// The gamma engine active for this display (NVAPI or GDI).
    fn engine(&self, edid_id: &str) -> crate::color::GammaEngine;
    /// Whether this display is routed to the Intel IGCL backend (pixtx). The
    /// GDI/NVAPI drift paths are inapplicable to Intel: Intel apply purges the
    /// GDI ramp to identity and drives a pixtx LUT, so a GDI read-back would
    /// always look "drifted" and re-apply every cycle.
    fn is_intel(&self, edid_id: &str) -> bool;
}

pub struct RealStateReader;

impl StateReader for RealStateReader {
    fn read_lut(&self, edid_id: &str) -> Result<[u16; 768], String> {
        let device = crate::nvapi::resolve_device_name(edid_id)
            .ok_or_else(|| "unknown monitor".to_string())?;
        crate::color::read_gamma_ramp(&device)
    }

    fn read_color(&self, edid_id: &str) -> Result<(f64, f64), String> {
        crate::nvapi::read_levels(edid_id)
    }

    fn read_nvcp_registry(&self, edid_id: &str) -> Option<(f64, f64, f64)> {
        let fns = crate::nvapi::fns()?;
        let device = crate::nvapi::resolve_device_name(edid_id)?;
        let display_id = crate::nvapi::display_id_for_device(fns, &device).ok()?;
        let luid = crate::nvgamma::display_luid(fns, display_id).ok()?;
        Some(crate::nvgamma::read_nvcp(luid))
    }

    fn engine(&self, edid_id: &str) -> crate::color::GammaEngine {
        crate::color::gamma_engine(edid_id)
    }

    fn is_intel(&self, edid_id: &str) -> bool {
        // Cached negative verdicts avoid a DriverStore re-scan every drift
        // cycle on non-Intel machines (L-4). The uncached path stays for
        // backend selection, which must remain hot-plug correct.
        crate::backend::intel::correlates_to_intel_cached(edid_id)
    }
}

/// Pure drift-check + conditional apply over snapshots. `force` reapplies
/// regardless of drift (manual Reapply-now path).
pub fn check_once(
    api: &dyn crate::color::ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    reader: &dyn StateReader,
    pins: &HashMap<String, String>,
    presets: &[crate::store::Preset],
    force: bool,
) -> Vec<EnforceEvent> {
    let mut events = Vec::new();
    for (edid_id, preset_id) in pins {
        let preset = match presets.iter().find(|p| &p.id == preset_id) {
            Some(p) => p,
            None => continue, // stale pin (preset gone without cascade): skip
        };
        if !api.is_connected(edid_id) {
            events.push(EnforceEvent {
                edid_id: edid_id.clone(),
                preset_id: preset_id.clone(),
                applied: false,
                error: None,
            });
            continue;
        }

        let drifted = force
            || match reader.engine(edid_id) {
                crate::color::GammaEngine::Nvapi => nvapi_drifted(preset, nv, reader, edid_id),
                crate::color::GammaEngine::Gdi => {
                    // Intel displays report the GDI engine (`gamma_engine`
                    // probes NVAPI, which Intel lacks), but Intel apply drives
                    // a pixtx LUT and purges the GDI ramp to identity. A GDI
                    // ramp read-back would therefore always differ from the
                    // expected preset ramp and force a re-apply every 10s
                    // (H1). A real Intel drift check would read the pixtx 1D
                    // LUT and compare against the composed expectation - but
                    // the pixtx 3x3 matrix (saturation/hue/rgb_gains) is NOT
                    // readable on this driver (spec §6/§10), so even a "real"
                    // check is partial, and running a full output-enumeration +
                    // pixtx read + compose each 10s cycle is disproportionate
                    // for that partial signal. Honest interim: skip drift
                    // enforcement for Intel and document the gap - an in-sync
                    // Intel display is never re-applied, and a genuinely
                    // drifted one is healed only by an explicit re-apply
                    // (`reapply_now_cmd`, force=true) or restart. pixtx state
                    // is runtime-only driver state (a reboot resets it), and
                    // only ChromaDeck writes it, so the foreign-clobber case
                    // the loop exists for is rare for Intel.
                    if reader.is_intel(edid_id) {
                        false
                    } else {
                        lut_drifted(preset, reader, edid_id)
                            || color_drifted(preset, nv, reader, edid_id)
                    }
                }
            };

        if !drifted {
            events.push(EnforceEvent {
                edid_id: edid_id.clone(),
                preset_id: preset_id.clone(),
                applied: false,
                error: None,
            });
            continue;
        }

        let result = crate::color::apply_color(api, nv, preset, edid_id);
        events.push(EnforceEvent {
            edid_id: edid_id.clone(),
            preset_id: preset_id.clone(),
            applied: result.gamma_applied || result.vibrance_applied,
            error: result.error,
        });
    }
    events
}

fn lut_drifted(preset: &crate::store::Preset, reader: &dyn StateReader, edid_id: &str) -> bool {
    match reader.read_lut(edid_id) {
        Ok(live) => {
            live != crate::color::build_gamma_ramp(
                preset.brightness,
                preset.contrast,
                preset.rgb_gains,
                preset.gamma,
            )
        }
        Err(_) => true, // unreadable state counts as drift (try to heal)
    }
}

fn color_drifted(
    preset: &crate::store::Preset,
    nv: &dyn crate::nvapi::NvColorApi,
    reader: &dyn StateReader,
    edid_id: &str,
) -> bool {
    let neutral = preset.vibrance == crate::nvapi::VIBRANCE_NEUTRAL
        && preset.hue_deg == crate::nvapi::HUE_NEUTRAL;
    if neutral && !nv.supported(edid_id) {
        return false; // unmanaged where unsupported: silent, no error
    }
    match reader.read_color(edid_id) {
        Ok((v, h)) => v != preset.vibrance || h != preset.hue_deg,
        Err(_) => true,
    }
}

/// Drift check for the NVAPI engine path: compare registry B/C/G (internal
/// scale) against preset-converted values. Then verify the GDI LUT is still
/// the identity ramp - exclusive-fullscreen games clobber only the GDI LUT
/// while leaving the NVAPI registry untouched, so registry-match alone would
/// miss the canonical evaporation case. Vibrance/hue are also checked.
fn nvapi_drifted(
    preset: &crate::store::Preset,
    nv: &dyn crate::nvapi::NvColorApi,
    reader: &dyn StateReader,
    edid_id: &str,
) -> bool {
    // Registry compare: B/C/G internal must equal preset's converted values.
    // Registry values are DWORDs written with rounding. Compare rounded to u32.
    // on both sides to avoid false-drift from f64 truncation (e.g. UI 37 ->
    // internal 94.8 -> DWORD 95 via round).
    match reader.read_nvcp_registry(edid_id) {
        Some((b, c, g)) => {
            let expected_b = crate::nvgamma::ui_to_internal(preset.brightness);
            let expected_c = crate::nvgamma::ui_to_internal(preset.contrast);
            let expected_g = preset.gamma * 100.0;
            if (b.round() as u32) != (expected_b.round() as u32)
                || (c.round() as u32) != (expected_c.round() as u32)
                || (g.round() as u32) != (expected_g.round() as u32)
            {
                return true; // registry drift
            }
        }
        None => return true, // unreachable registry -> treat as drift (heal attempt)
    };

    // GDI LUT must be identity - NVAPI owns the color pipeline. A foreign
    // writer (e.g. exclusive-fullscreen game) only touches the GDI LUT, so
    // a registry match alone would miss the evaporation entirely.
    let identity = crate::color::build_gamma_ramp(1.0, 1.0, [1.0, 1.0, 1.0], 1.0);
    match reader.read_lut(edid_id) {
        Ok(live) => {
            if live != identity {
                return true; // foreign LUT writer detected
            }
        }
        Err(_) => return true, // unreadable -> treat as drift
    };

    // Vibrance/hue check (same logic as GDI branch).
    color_drifted(preset, nv, reader, edid_id)
}

/// Background task: check every 10s. Spawned once from setup (Task 4).
pub async fn enforce_loop(app: tauri::AppHandle) {
    loop {
        check_and_enforce(&app);
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
}

fn check_and_enforce(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (pins, presets) = match app.try_state::<crate::store::AppStore>() {
        Some(s) => match s.0.lock() {
            Ok(store) => (store.list_pins(), store.list_presets()),
            Err(_) => return,
        },
        None => return,
    };
    if pins.is_empty() {
        return;
    }
    let api = crate::color::RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let reader = RealStateReader;
    let _ = check_once(&api, &nv, &reader, &pins, &presets, false);
}

#[tauri::command]
pub fn reapply_now_cmd(state: tauri::State<'_, crate::store::AppStore>) -> Vec<EnforceEvent> {
    let (pins, presets) = match state.0.lock() {
        Ok(store) => (store.list_pins(), store.list_presets()),
        Err(e) => {
            return vec![EnforceEvent {
                edid_id: String::new(),
                preset_id: String::new(),
                applied: false,
                error: Some(format!("store lock: {e}")),
            }]
        }
    };
    let api = crate::color::RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let reader = RealStateReader;
    check_once(&api, &nv, &reader, &pins, &presets, true)
}

// --- Lifecycle: startup reassertion + exit semantics ------------------------
//
// ChromaDeck's documented promise (README "Pin & enforce", PRODUCT "enforcement
// just holds", and the driver-registry persistence feature) is that applied
// colour SURVIVES a clean exit and is reasserted on the next launch. The app
// has never promised to wipe displays on quit; "Reset" is the explicit action
// that does that. Phase F therefore:
//
//   STARTUP - every connected display with a pin OR an applied record is
//   re-applied through the backend registry. If the recorded preset no longer
//   exists (removed while the app was closed), the display is restored through
//   the same backend path `reset_monitor` uses, and the stale records are
//   cleared. Disconnected displays are skipped untouched.
//
//   EXIT - policy is `KeepApplied` (see `ExitPolicy`). Per backend:
//     * nvapi - NVCP registry persistence is the documented feature; quitting
//       must not erase it.
//     * gdi   - the OS gamma ramp is session state; Windows clears it on
//       logoff/reboot. Nothing to do.
//     * intel - the pixtx pipeline is driver state and its unattended reset is
//       best-effort only (`ctlDisplayFeatureReset` is not exported on this
//       driver), so the exit path never claims a restore it cannot verify.
//   A `Restore` policy exists as a tested seam for an explicit
//   "quit and reset" flow, but the tray does NOT use it today.
//
// Shutdown never panics on a disconnected display: connectivity is checked
// first and a disconnected target is reported as skipped, with no write.

/// Divergence between persisted records and the store's presets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleAction {
    /// Preset still exists and the display is connected: re-apply it.
    Apply(String),
    /// Recorded preset no longer exists: restore the display to defaults.
    Restore(String),
    /// Display is disconnected: leave it (and its records) untouched.
    Skip,
}

/// One startup lifecycle outcome (also useful as an honest diagnostic log).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LifecycleEvent {
    pub edid_id: String,
    pub preset_id: Option<String>,
    /// "apply" | "restore" | "skip"
    pub action: String,
    pub applied: bool,
    pub error: Option<String>,
}

/// Merge pins and applied records into one target list, pins winning, sorted
/// by EDID for deterministic behaviour and tests.
pub fn lifecycle_targets(
    pins: &HashMap<String, String>,
    applied: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut targets = pins.clone();
    for (edid_id, preset_id) in applied {
        targets
            .entry(edid_id.clone())
            .or_insert_with(|| preset_id.clone());
    }
    let mut ordered: Vec<(String, String)> = targets.into_iter().collect();
    ordered.sort_by(|a, b| a.0.cmp(&b.0));
    ordered
}

/// Pure startup plan. No hardware: connectivity is injected.
pub fn startup_plan(
    targets: &[(String, String)],
    presets: &[crate::store::Preset],
    connected: &dyn Fn(&str) -> bool,
) -> Vec<(String, LifecycleAction)> {
    targets
        .iter()
        .map(|(edid_id, preset_id)| {
            let action = if !connected(edid_id) {
                LifecycleAction::Skip
            } else if presets.iter().any(|p| &p.id == preset_id) {
                LifecycleAction::Apply(preset_id.clone())
            } else {
                LifecycleAction::Restore(preset_id.clone())
            };
            (edid_id.clone(), action)
        })
        .collect()
}

/// Execute the startup plan through the backend abstraction.
///
/// `is_intel` reports whether a display routes to the Intel IGCL backend.
/// Intel displays are NOT auto-reapplied at startup (see C1): pixtx state is
/// runtime-only driver state - a reboot resets it to factory default, while a
/// restart-without-reboot may still carry the previous session's applied
/// curve. A startup apply would capture whichever of those is present as the
/// "pre-apply" state, so a later Reset would return the panel to that
/// (possibly non-factory) state and falsely report success. Skipping the Intel
/// reapply keeps the restore guarantee honest: Reset on a display never
/// applied this session reports "no capture" rather than faking a restore.
///
/// As a side effect (M-4), Intel-correlated targets with a persisted record
/// are marked capture-untrusted via `intel::mark_capture_untrusted`, so a
/// later first apply cannot capture the leftover curve as its baseline.
pub fn run_startup(
    api: &dyn crate::color::ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    targets: &[(String, String)],
    presets: &[crate::store::Preset],
    is_intel: &dyn Fn(&str) -> bool,
) -> Vec<LifecycleEvent> {
    // M-4: mark every Intel-correlated target (a persisted applied/pin record)
    // as capture-untrusted for this session. The persisted record means the
    // pixtx state may be ChromaDeck's own leftover curve after a
    // restart-without-reboot; the first apply must not capture that leftover as
    // a trusted factory baseline. `IntelBackend::apply` refuses (or verifies
    // the LUT is the factory-identity default) accordingly. Displays with no
    // persisted record are never marked, so a fresh-boot/no-record apply is
    // unaffected.
    for (edid_id, _preset_id) in targets {
        if is_intel(edid_id) {
            crate::backend::intel::mark_capture_untrusted(edid_id);
        }
    }

    startup_plan(targets, presets, &|edid_id| api.is_connected(edid_id))
        .into_iter()
        .map(|(edid_id, action)| match action {
            LifecycleAction::Skip => LifecycleEvent {
                edid_id,
                preset_id: None,
                action: "skip".into(),
                applied: false,
                error: None,
            },
            LifecycleAction::Apply(preset_id) => {
                // Skip Intel auto-reapply at startup (documented above).
                if is_intel(&edid_id) {
                    return LifecycleEvent {
                        edid_id,
                        preset_id: Some(preset_id),
                        action: "skip".into(),
                        applied: false,
                        error: Some(
                            "skipped Intel startup reapply: pixtx state is runtime-only and \
                             capturing it here would poison Reset's restore guarantee (a reboot \
                             restores the factory default)"
                                .into(),
                        ),
                    };
                }
                let preset = match presets.iter().find(|p| p.id == preset_id) {
                    Some(p) => p,
                    None => {
                        return LifecycleEvent {
                            edid_id,
                            preset_id: Some(preset_id),
                            action: "apply".into(),
                            applied: false,
                            error: Some("preset disappeared during startup".into()),
                        }
                    }
                };
                let result = crate::color::apply_color(api, nv, preset, &edid_id);
                LifecycleEvent {
                    edid_id,
                    preset_id: Some(preset_id),
                    action: "apply".into(),
                    applied: result.gamma_applied || result.vibrance_applied,
                    error: result.error,
                }
            }
            LifecycleAction::Restore(preset_id) => {
                // Parity with the explicit Reset action: the backend owns the
                // reset path (GDI identity ramp, NVAPI identity+persist, Intel
                // RESTORE_DEFAULT).
                let result = crate::color::reset_monitor(api, nv, &edid_id);
                LifecycleEvent {
                    edid_id,
                    preset_id: Some(preset_id),
                    action: "restore".into(),
                    applied: result.gamma_applied || result.vibrance_applied,
                    error: result.error,
                }
            }
        })
        .collect()
}

/// Startup entry point: reassert pins/applied presets, restore stale records,
/// then clear those stale records. Runs off the main thread (spawned in setup).
pub fn startup_reapply(app: &tauri::AppHandle) {
    use tauri::Manager;
    let state = match app.try_state::<crate::store::AppStore>() {
        Some(s) => s,
        None => return,
    };
    let (targets, presets) = match state.0.lock() {
        Ok(store) => (
            lifecycle_targets(&store.list_pins(), &store.list_applied()),
            store.list_presets(),
        ),
        Err(_) => return,
    };
    if targets.is_empty() {
        return;
    }

    let api = crate::color::RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let events = run_startup(
        &api,
        &nv,
        &targets,
        &presets,
        &|edid_id| crate::backend::intel::correlates_to_intel(edid_id),
    );

    let stale: Vec<String> = events
        .iter()
        .filter(|e| e.action == "restore")
        .map(|e| e.edid_id.clone())
        .collect();

    for event in &events {
        if let Some(error) = &event.error {
            eprintln!(
                "ChromaDeck startup: {} {} failed: {error}",
                event.action, event.edid_id
            );
        }
    }

    // A preset no longer exists, so its records can never apply again. Clear
    // them even when the restore write failed (the failure is logged): keeping
    // a ghost IN USE record would over-claim.
    if !stale.is_empty() {
        if let Ok(mut store) = state.0.lock() {
            for edid_id in stale {
                store.clear_applied(&edid_id);
                store.unpin_monitor(&edid_id);
            }
        }
    }
}

/// Quit policy. `KeepApplied` is the documented behaviour; `Restore` is the
/// tested seam for an explicit "quit and reset" flow and is not wired to the
/// tray today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitPolicy {
    /// Leave applied colour in place (documented: enforcement persists).
    KeepApplied,
    /// Explicitly restore every connected target through its backend.
    #[allow(dead_code)]
    Restore,
}

/// One display's exit outcome. `restored` is true only when a backend restore
/// reported success; `detail` states plainly what happened (or why nothing was
/// attempted) so logs never fake a cleanup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExitOutcome {
    pub edid_id: String,
    pub backend: String,
    pub restored: bool,
    pub detail: String,
}

/// Backend lookup seam so exit routing is testable without hardware.
pub trait BackendSelector {
    fn select_backend(&self, edid_id: &str) -> &dyn crate::backend::ColorBackend;

    /// Cheap backend identity for classification-only paths (`KeepApplied`).
    /// Implementations MUST NOT load a driver library; the default is
    /// deliberately non-committal so a test double without a hint still works.
    fn backend_id_hint(&self, _edid_id: &str) -> &'static str {
        "unknown"
    }
}

impl BackendSelector for crate::backend::BackendRegistry {
    fn select_backend(&self, edid_id: &str) -> &dyn crate::backend::ColorBackend {
        crate::backend::BackendRegistry::select(self, edid_id)
    }

    fn backend_id_hint(&self, edid_id: &str) -> &'static str {
        crate::backend::BackendRegistry::backend_id_hint(self, edid_id)
    }
}

fn keep_detail(backend_id: &str) -> &'static str {
    match backend_id {
        "nvapi" => {
            "kept: NVCP driver-registry persistence (only an explicit Reset clears it)"
        }
        "gdi" => "kept: OS gamma ramp is session state, cleared by Windows at logoff/reboot",
        "intel" => {
            "kept: Intel pixtx state is driver-level; unattended reset is best-effort only"
        }
        _ => "kept: applied colour persists by design",
    }
}

/// Compute/execute exit semantics per display.
///
/// With `KeepApplied` this is a pure classification: no backend write happens.
/// With `Restore` every connected target goes through its selected backend's
/// `restore`. Disconnected displays are skipped before any write, so a
/// display unplugged during shutdown cannot cause a failed driver call.
pub fn run_exit(
    policy: ExitPolicy,
    selector: &dyn BackendSelector,
    api: &dyn crate::color::ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    targets: &[(String, String)],
    connected: &dyn Fn(&str) -> bool,
) -> Vec<ExitOutcome> {
    let mut outcomes: Vec<ExitOutcome> = Vec::new();
    for (edid_id, _preset_id) in targets {
        // Connectivity first: never probe/load a driver for a display that
        // vanished during shutdown.
        if !connected(edid_id) {
            outcomes.push(ExitOutcome {
                edid_id: edid_id.clone(),
                backend: "n/a".into(),
                restored: false,
                detail: "skipped: display disconnected during shutdown (no write attempted)"
                    .into(),
            });
            continue;
        }
        match policy {
            // Classification only: never call `select_backend` here, because
            // selection probes NVAPI/IGCL and can stall tray quit. The cheap
            // hint never loads a driver library.
            ExitPolicy::KeepApplied => {
                let backend_id = selector.backend_id_hint(edid_id);
                outcomes.push(ExitOutcome {
                    edid_id: edid_id.clone(),
                    backend: backend_id.to_string(),
                    restored: false,
                    detail: keep_detail(backend_id).into(),
                });
            }
            ExitPolicy::Restore => {
                let backend = selector.select_backend(edid_id);
                let result = backend.restore(api, nv, edid_id);
                outcomes.push(ExitOutcome {
                    edid_id: edid_id.clone(),
                    backend: backend.id().to_string(),
                    restored: result.gamma_applied || result.vibrance_applied,
                    detail: result
                        .error
                        .unwrap_or_else(|| "restored through the selected backend".into()),
                });
            }
        }
    }
    outcomes
}

/// Tray-quit entry point. Documents the chosen policy in the log and never
/// writes to hardware; safe when a display disconnects mid-shutdown.
pub fn shutdown_sweep(app: &tauri::AppHandle) {
    use tauri::Manager;
    let state = match app.try_state::<crate::store::AppStore>() {
        Some(s) => s,
        None => return,
    };
    let targets = match state.0.lock() {
        Ok(store) => lifecycle_targets(&store.list_pins(), &store.list_applied()),
        Err(_) => return,
    };
    if targets.is_empty() {
        return;
    }

    let selector = crate::backend::BackendRegistry::new();
    let api = crate::color::RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let outcomes = run_exit(
        ExitPolicy::KeepApplied,
        &selector,
        &api,
        &nv,
        &targets,
        &|edid_id| crate::color::ColorApi::is_connected(&api, edid_id),
    );
    for outcome in outcomes {
        eprintln!(
            "ChromaDeck exit: {} [{}] {}",
            outcome.edid_id, outcome.backend, outcome.detail
        );
    }
}
