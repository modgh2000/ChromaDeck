// -- Vendor-neutral colour backend abstraction -----------------------------
// Windows-only. A `ColorBackend` owns the driver-level colour pipeline for
// one class of display hardware (gamma LUT, RGB gains, vibrance/hue).
// ICC association stays in the orchestrator (`color.rs`) because Mscms is
// already GPU-vendor-neutral.
//
// Phase B is a behavior-preserving refactor: the existing NVAPI and GDI
// paths are wrapped, not rewritten. Phase E adds `backend/intel.rs` on top
// of this trait.

// The capability surface (`AdjustmentCap`, `AdjustmentCapability`, the
// ADJUSTMENT_* names, and the `id`/`probe` trait methods) is forward-looking:
// Phase C wires it to a `get_display_capabilities` command. `apply`/`restore`
// are already exercised (B2/B3). Suppress dead_code until Phase C lands.
#![allow(dead_code)]

use crate::color::{gdi_identity_purge, identity_ramp, ApplyResult, ColorApi, GammaEngine};
use crate::nvapi::{
    display_id_for_device, fns, resolve_device_name, HUE_NEUTRAL, NvColorApi, VIBRANCE_NEUTRAL,
};
use crate::nvgamma::{display_luid, nvcp_ramp, persist_nvcp, set_target_gamma, ui_to_internal};
use crate::store::Preset;

pub mod intel;
pub use intel::IntelBackend;

// -- Capabilities -----------------------------------------------------------

/// Per-adjustment capability verdict for a display.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdjustmentCap {
    /// Fully supported natively.
    Supported,
    /// Not supported; carries a human-readable reason.
    Unsupported(&'static str),
    /// Supported approximately; carries a note describing the mapping.
    Approximate(&'static str),
}

/// Canonical adjustment names (capability keys; serialized to the frontend
/// in Phase C).
pub const ADJUSTMENT_GAMMA: &str = "gamma";
pub const ADJUSTMENT_BRIGHTNESS: &str = "brightness";
pub const ADJUSTMENT_CONTRAST: &str = "contrast";
pub const ADJUSTMENT_RGB_GAINS: &str = "rgb_gains";
pub const ADJUSTMENT_SATURATION: &str = "saturation";
pub const ADJUSTMENT_VIBRANCE: &str = "vibrance";
pub const ADJUSTMENT_HUE: &str = "hue";

/// Capability for one named adjustment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdjustmentCapability {
    pub adjustment: &'static str,
    pub cap: AdjustmentCap,
}

// -- ColorBackend trait ---------------------------------------------------

/// A vendor-neutral colour backend for one class of display hardware.
pub trait ColorBackend {
    /// Stable identifier for this backend (e.g. "nvapi", "gdi").
    fn id(&self) -> &'static str;

    /// Per-adjustment capability report for a display.
    fn probe(&self, edid_id: &str) -> Vec<AdjustmentCapability>;

    /// Apply a preset's driver-level colour state (no ICC).
    fn apply(
        &self,
        api: &dyn ColorApi,
        nv: &dyn NvColorApi,
        preset: &Preset,
        edid_id: &str,
    ) -> ApplyResult;

    /// Restore the display to system defaults (no ICC).
    fn restore(&self, api: &dyn ColorApi, nv: &dyn NvColorApi, edid_id: &str) -> ApplyResult;
}

// -- Shared driver-level helpers (engine-independent) ------------------

/// Append an error message to an accumulated `Option<String>`, joining
/// multiple messages with "; " (matches the pre-refactor error format).
fn append_error(error: &mut Option<String>, msg: String) {
    *error = Some(match error.take() {
        Some(prev) => format!("{prev}; {msg}"),
        None => msg,
    });
}

/// Vibrance/hue overlay, shared by both backends' `apply`. Written when the
/// preset is non-neutral OR the display reports support (so neutral presets
/// fully restore prior state); skipped silently only where NVAPI reports
/// unsupported.
fn apply_vibrance(
    nv: &dyn NvColorApi,
    edid_id: &str,
    vibrance: f64,
    hue_deg: f64,
    vibrance_applied: &mut bool,
    error: &mut Option<String>,
) {
    let neutral = vibrance == VIBRANCE_NEUTRAL && hue_deg == HUE_NEUTRAL;
    if !neutral || nv.supported(edid_id) {
        match nv.set(edid_id, vibrance, hue_deg) {
            Ok(()) => *vibrance_applied = true,
            Err(e) => append_error(error, format!("vibrance: {e}")),
        }
    }
}

/// Neutral vibrance/hue restore, shared by both backends' `restore`.
/// Attempted whenever supported (failures reported), plus best-effort when
/// unsupported (failures swallowed) so a write-works-but-probe-fails display
/// can't get stuck silently.
fn restore_vibrance(
    nv: &dyn NvColorApi,
    edid_id: &str,
    vibrance_applied: &mut bool,
    error: &mut Option<String>,
) {
    if nv.supported(edid_id) {
        match nv.set(edid_id, VIBRANCE_NEUTRAL, HUE_NEUTRAL) {
            Ok(()) => *vibrance_applied = true,
            Err(e) => append_error(error, format!("vibrance: {e}")),
        }
        // Verify the panel reflects neutral (catches accepted-but-ineffective
        // writes). Unreadable != evidence of stuckness; the write-Ok stands.
        match nv.levels(edid_id) {
            Ok((v, h)) if v == VIBRANCE_NEUTRAL && h == HUE_NEUTRAL => {}
            Ok((v, h)) => append_error(
                error,
                format!("reset: panel still reports vibrance {v} hue {h} (expected neutral 50/0)"),
            ),
            Err(_) => {}
        }
    } else {
        let _ = nv.set(edid_id, VIBRANCE_NEUTRAL, HUE_NEUTRAL);
    }
}

/// Verify the GDI LUT is identity after a reset (shared by both backends).
/// A mismatch means the panel doesn't reflect the reset - report, don't
/// claim success. An unreadable LUT is not evidence either way; stay silent.
fn verify_gdi_identity(api: &dyn ColorApi, edid_id: &str, error: &mut Option<String>) {
    match api.read_gamma_ramp(edid_id) {
        Ok(ramp) if ramp == identity_ramp() => {}
        Ok(ramp) => {
            let peak = ramp.iter().max().copied().unwrap_or(0) as f64 / 65535.0;
            append_error(
                error,
                format!("reset: gamma ramp read-back differs from identity (peak {peak:.2})"),
            );
        }
        Err(_) => {}
    }
}

// -- NvapiBackend ---------------------------------------------------------

/// NVIDIA backend: NVAPI gamma (SetTargetGammaCorrection) + vibrance/hue
/// (DVC), with NVCP registry persistence and a GDI identity purge before
/// each write. Verbatim port of the pre-refactor `color.rs` NVAPI branch.
pub struct NvapiBackend;

impl ColorBackend for NvapiBackend {
    fn id(&self) -> &'static str {
        "nvapi"
    }

    fn probe(&self, _edid_id: &str) -> Vec<AdjustmentCapability> {
        // Phase C replaces the vibrance/hue entries with a live DVC probe.
        vec![
            AdjustmentCapability { adjustment: ADJUSTMENT_GAMMA, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_BRIGHTNESS, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_CONTRAST, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_RGB_GAINS, cap: AdjustmentCap::Supported },
            AdjustmentCapability {
                adjustment: ADJUSTMENT_SATURATION,
                cap: AdjustmentCap::Unsupported(
                    "NVAPI has no desktop saturation control (vibrance is the closest analogue)",
                ),
            },
            AdjustmentCapability { adjustment: ADJUSTMENT_VIBRANCE, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_HUE, cap: AdjustmentCap::Supported },
        ]
    }

    fn apply(
        &self,
        api: &dyn ColorApi,
        nv: &dyn NvColorApi,
        preset: &Preset,
        target_edid: &str,
    ) -> ApplyResult {
        let mut gamma_applied = false;
        let mut vibrance_applied = false;
        let mut error: Option<String> = None;

        // Stage-purity: reset GDI LUT to identity before the NVAPI set.
        // Exclusive-fullscreen games may have clobbered only the GDI LUT
        // (the canonical evaporation case); this guarantees the NVAPI path
        // owns the full pipeline on every apply. Best-effort - failure
        // appends error but does NOT block NVAPI.
        let gdi_purge_err = gdi_identity_purge(api, target_edid);

        // NVAPI path: NVCP transfer math + set_target_gamma + persist
        let nvapi_result = (|| -> Result<(), String> {
            let fns = fns().ok_or_else(|| "NVAPI unavailable".to_string())?;
            let device_name = resolve_device_name(target_edid)
                .ok_or_else(|| format!("no display device found for EDID {target_edid}"))?;
            let display_id = display_id_for_device(fns, &device_name)?;

            let b_int = ui_to_internal(preset.brightness);
            let c_int = ui_to_internal(preset.contrast);
            let mut ramp = nvcp_ramp(b_int, c_int, preset.gamma);

            // Apply RGB gains as post-multiplier (preserves existing behavior)
            for i in 0..1024 {
                ramp[i * 3] = (ramp[i * 3] as f64 * preset.rgb_gains[0]).clamp(0.0, 1.0) as f32;
                ramp[i * 3 + 1] =
                    (ramp[i * 3 + 1] as f64 * preset.rgb_gains[1]).clamp(0.0, 1.0) as f32;
                ramp[i * 3 + 2] =
                    (ramp[i * 3 + 2] as f64 * preset.rgb_gains[2]).clamp(0.0, 1.0) as f32;
            }

            set_target_gamma(fns, display_id, &ramp)?;

            // Best-effort persist: failure does NOT fail the apply
            if let Ok(luid) = display_luid(fns, display_id) {
                let b_arr = [b_int; 3];
                let c_arr = [c_int; 3];
                let g_arr = [preset.gamma * 100.0; 3];
                if let Err(e) = persist_nvcp(luid, b_arr, c_arr, g_arr) {
                    return Err(format!("persist: {e}"));
                }
            }

            Ok(())
        })();

        match nvapi_result {
            Ok(()) => gamma_applied = true,
            Err(e) => {
                if e.starts_with("persist: ") {
                    // Gamma succeeded but persist failed - gamma still counts as applied
                    gamma_applied = true;
                    append_error(&mut error, e);
                } else {
                    append_error(&mut error, format!("gamma: {e}"));
                }
            }
        }

        // Append GDI-purge error (best-effort, gamma already tracked).
        if let Some(e) = gdi_purge_err {
            append_error(&mut error, e);
        }

        apply_vibrance(
            nv,
            target_edid,
            preset.vibrance,
            preset.hue_deg,
            &mut vibrance_applied,
            &mut error,
        );

        ApplyResult {
            icc_applied: false,
            gamma_applied,
            vibrance_applied,
            error,
        }
    }

    fn restore(&self, api: &dyn ColorApi, nv: &dyn NvColorApi, edid_id: &str) -> ApplyResult {
        let mut gamma_applied = false;
        let mut vibrance_applied = false;
        let mut error: Option<String> = None;

        // GDI purge first (mirrors apply): clear any stale OS LUT so only
        // the driver ramp governs the panel.
        if let Some(e) = gdi_identity_purge(api, edid_id) {
            append_error(&mut error, e);
        }

        // NVAPI reset: identity ramp + neutral 100s persist
        let nvapi_result = (|| -> Result<(), String> {
            let fns = fns().ok_or_else(|| "NVAPI unavailable".to_string())?;
            let device_name = resolve_device_name(edid_id)
                .ok_or_else(|| format!("no display device found for EDID {edid_id}"))?;
            let display_id = display_id_for_device(fns, &device_name)?;

            // Identity ramp at neutral (100, 100, 1.0)
            let ramp = nvcp_ramp(100.0, 100.0, 1.0);
            set_target_gamma(fns, display_id, &ramp)?;

            // Persist neutral 100s
            if let Ok(luid) = display_luid(fns, display_id) {
                let neutral = [100.0; 3];
                if let Err(e) = persist_nvcp(luid, neutral, neutral, neutral) {
                    return Err(format!("persist: {e}"));
                }
            }

            Ok(())
        })();

        match nvapi_result {
            Ok(()) => gamma_applied = true,
            Err(e) => {
                if e.starts_with("persist: ") {
                    // Gamma reset succeeded but persist failed
                    gamma_applied = true;
                    append_error(&mut error, e);
                } else {
                    append_error(&mut error, format!("reset: {e}"));
                }
            }
        }

        restore_vibrance(nv, edid_id, &mut vibrance_applied, &mut error);
        verify_gdi_identity(api, edid_id, &mut error);

        ApplyResult {
            icc_applied: false,
            gamma_applied,
            vibrance_applied,
            error,
        }
    }
}

// -- GdiBackend -----------------------------------------------------------

/// Universal GDI fallback backend: gamma-family only, via `SetDeviceGammaRamp`.
/// Brightness/contrast are mapped onto ramp gains (matching the pre-refactor
/// gain model); vibrance/hue are attempted best-effort through NVAPI (same as
/// before) since GDI has no native vibrance control.
pub struct GdiBackend;

impl ColorBackend for GdiBackend {
    fn id(&self) -> &'static str {
        "gdi"
    }

    fn probe(&self, _edid_id: &str) -> Vec<AdjustmentCapability> {
        vec![
            AdjustmentCapability { adjustment: ADJUSTMENT_GAMMA, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_BRIGHTNESS, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_CONTRAST, cap: AdjustmentCap::Supported },
            AdjustmentCapability { adjustment: ADJUSTMENT_RGB_GAINS, cap: AdjustmentCap::Supported },
            AdjustmentCapability {
                adjustment: ADJUSTMENT_SATURATION,
                cap: AdjustmentCap::Unsupported("GDI ramp has no saturation control"),
            },
            AdjustmentCapability {
                adjustment: ADJUSTMENT_VIBRANCE,
                cap: AdjustmentCap::Unsupported("GDI ramp has no vibrance control"),
            },
            AdjustmentCapability {
                adjustment: ADJUSTMENT_HUE,
                cap: AdjustmentCap::Unsupported("GDI ramp has no hue control"),
            },
        ]
    }

    fn apply(
        &self,
        api: &dyn ColorApi,
        nv: &dyn NvColorApi,
        preset: &Preset,
        target_edid: &str,
    ) -> ApplyResult {
        let mut gamma_applied = false;
        let mut vibrance_applied = false;
        let mut error: Option<String> = None;

        // GDI fallback with mapped gains: gain = 0.8 + 0.004 * ui_val
        // (neutral 50 -> gain 1.0, matching the old gain-model neutral)
        let b_gain = 0.8 + 0.004 * preset.brightness;
        let c_gain = 0.8 + 0.004 * preset.contrast;
        match api.set_gamma_ramp(
            target_edid,
            b_gain,
            c_gain,
            preset.rgb_gains,
            preset.gamma,
        ) {
            Ok(()) => gamma_applied = true,
            Err(e) => append_error(&mut error, format!("gamma: {e}")),
        }

        apply_vibrance(
            nv,
            target_edid,
            preset.vibrance,
            preset.hue_deg,
            &mut vibrance_applied,
            &mut error,
        );

        ApplyResult {
            icc_applied: false,
            gamma_applied,
            vibrance_applied,
            error,
        }
    }

    fn restore(&self, api: &dyn ColorApi, nv: &dyn NvColorApi, edid_id: &str) -> ApplyResult {
        let mut gamma_applied = false;
        let mut vibrance_applied = false;
        let mut error: Option<String> = None;

        // GDI reset: unchanged identity gain values (1.0 = neutral)
        match api.set_gamma_ramp(edid_id, 1.0, 1.0, [1.0, 1.0, 1.0], 1.0) {
            Ok(()) => gamma_applied = true,
            Err(e) => append_error(&mut error, format!("reset: {e}")),
        }

        restore_vibrance(nv, edid_id, &mut vibrance_applied, &mut error);
        verify_gdi_identity(api, edid_id, &mut error);

        ApplyResult {
            icc_applied: false,
            gamma_applied,
            vibrance_applied,
            error,
        }
    }
}

// — BackendRegistry ——————————————————————————————————————————————————————————

/// Picks the colour backend for a display. Backends are injected as trait
/// objects so tests can register fakes; `new()` wires the production
/// NvapiBackend/GdiBackend pair.
pub struct BackendRegistry {
    nvapi: Box<dyn ColorBackend>,
    gdi: Box<dyn ColorBackend>,
    intel: Option<Box<dyn ColorBackend>>,
    intel_correlates: fn(&str) -> bool,
}

impl BackendRegistry {
    /// Construct a registry with injected backends (test double). Intel is
    /// absent, so selection never consults the IGCL layer.
    #[cfg(test)]
    pub fn with_backends(nvapi: Box<dyn ColorBackend>, gdi: Box<dyn ColorBackend>) -> Self {
        BackendRegistry {
            nvapi,
            gdi,
            intel: None,
            intel_correlates: |_| false,
        }
    }

    /// Construct a registry with injected backends AND an Intel correlation
    /// predicate (test double) - exercises the full NVIDIA->Intel->GDI order.
    #[cfg(test)]
    pub fn with_backends_and_intel(
        nvapi: Box<dyn ColorBackend>,
        gdi: Box<dyn ColorBackend>,
        intel: Box<dyn ColorBackend>,
        intel_correlates: fn(&str) -> bool,
    ) -> Self {
        BackendRegistry {
            nvapi,
            gdi,
            intel: Some(intel),
            intel_correlates,
        }
    }

    /// Production registry: NVIDIA NVAPI, Intel IGCL, and GDI fallback.
    /// The Intel backend is bound to the real (lazily-loaded) IGCL session;
    /// constructing it does NOT load the DLL - the first load happens inside
    /// `select` (correlation) or the first `probe`/`apply`/`restore`.
    pub fn new() -> Self {
        BackendRegistry {
            nvapi: Box::new(NvapiBackend),
            gdi: Box::new(GdiBackend),
            intel: Some(Box::new(intel::IntelBackend::new())),
            intel_correlates: intel::correlates_to_intel,
        }
    }

    /// Select the backend for a display, in strict precedence order:
    ///  1. NVIDIA - any display NVAPI can resolve keeps its existing dGPU
    ///     path (hybrid-graphics HDMI). Never touches the Intel DLL.
    ///  2. Intel - only when the display correlates to a unique active Intel
    ///     output (`correlates_to_intel`). Ambiguous/absent -> not Intel.
    ///  3. GDI - universal fallback.
    /// Computed per call (no cache): not on a hot path; caching would go
    /// stale on hot-plug / MUX changes.
    pub fn select(&self, edid_id: &str) -> &dyn ColorBackend {
        if crate::color::gamma_engine(edid_id) == GammaEngine::Nvapi {
            return self.nvapi.as_ref();
        }
        if let Some(intel) = self.intel.as_ref() {
            if (self.intel_correlates)(edid_id) {
                return intel.as_ref();
            }
        }
        self.gdi.as_ref()
    }

    /// Cheap backend classification for logging/classification-only paths.
    ///
    /// Unlike [`select`], this NEVER initialises a driver library: NVAPI is
    /// only consulted when it is already loaded, and Intel is only claimed
    /// when the IGCL session is already live. If neither API was live it
    /// returns "unknown" rather than guessing. This keeps tray quit
    /// (`KeepApplied`) from stalling on a DLL load merely to print a log line.
    pub fn backend_id_hint(&self, edid_id: &str) -> &'static str {
        let intel_live = self.intel.is_some() && intel::session_loaded();

        // NVAPI: only classify when it is already initialised. Calling
        // `gamma_engine` would otherwise load nvapi64.dll.
        if crate::nvapi::loaded()
            && crate::color::gamma_engine(edid_id) == GammaEngine::Nvapi
        {
            return "nvapi";
        }
        if intel_live && (self.intel_correlates)(edid_id) {
            return "intel";
        }
        // No driver was loaded to produce this verdict. If neither API was
        // live we cannot know the backend without loading one, so say so
        // rather than guessing.
        if !crate::nvapi::loaded() && !intel_live {
            return "unknown";
        }
        "gdi"
    }

    /// Select the backend for a known engine (pure, unit-testable).
    pub fn select_engine(&self, engine: GammaEngine) -> &dyn ColorBackend {
        match engine {
            GammaEngine::Nvapi => self.nvapi.as_ref(),
            GammaEngine::Gdi => self.gdi.as_ref(),
        }
    }
}

impl Default for BackendRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// — Tests ————————————————————————————————————————————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal fake backend for exercising registry selection.
    struct FakeBackend(&'static str);

    impl ColorBackend for FakeBackend {
        fn id(&self) -> &'static str {
            self.0
        }

        fn probe(&self, _edid_id: &str) -> Vec<AdjustmentCapability> {
            vec![]
        }

        fn apply(
            &self,
            _api: &dyn ColorApi,
            _nv: &dyn NvColorApi,
            _preset: &Preset,
            _edid_id: &str,
        ) -> ApplyResult {
            ApplyResult::offline()
        }

        fn restore(
            &self,
            _api: &dyn ColorApi,
            _nv: &dyn NvColorApi,
            _edid_id: &str,
        ) -> ApplyResult {
            ApplyResult::offline()
        }
    }

    // — Selection logic ——————————————————————————————————————————————————————

    #[test]
    fn selects_nvapi_backend_for_nvapi_engine() {
        let reg = BackendRegistry::with_backends(
            Box::new(FakeBackend("fake-nvapi")),
            Box::new(FakeBackend("fake-gdi")),
        );
        assert_eq!(reg.select_engine(GammaEngine::Nvapi).id(), "fake-nvapi");
    }

    #[test]
    fn selects_gdi_backend_for_gdi_engine() {
        let reg = BackendRegistry::with_backends(
            Box::new(FakeBackend("fake-nvapi")),
            Box::new(FakeBackend("fake-gdi")),
        );
        assert_eq!(reg.select_engine(GammaEngine::Gdi).id(), "fake-gdi");
    }

    #[test]
    fn unknown_edid_resolves_to_gdi_backend() {
        // An EDID that resolves to no NVIDIA display probes as GDI; the
        // registry must follow. Deterministic regardless of hardware.
        let reg = BackendRegistry::with_backends(
            Box::new(FakeBackend("fake-nvapi")),
            Box::new(FakeBackend("fake-gdi")),
        );
        assert_eq!(reg.select("NO_SUCH_EDID").id(), "fake-gdi");
    }

    #[test]
    fn select_routes_intel_correlated_to_intel_else_gdi() {
        // Non-NVIDIA EDID (probes GDI at the NVAPI layer) + a correlation
        // predicate that only matches "EDID:INTEL".
        let reg = BackendRegistry::with_backends_and_intel(
            Box::new(FakeBackend("fake-nvapi")),
            Box::new(FakeBackend("fake-gdi")),
            Box::new(FakeBackend("fake-intel")),
            |edid| edid == "EDID:INTEL",
        );
        assert_eq!(reg.select("EDID:INTEL").id(), "fake-intel");
        assert_eq!(reg.select("EDID:OTHER").id(), "fake-gdi");
    }

    // — AdjustmentCap shape ——————————————————————————————————————————————————

    #[test]
    fn adjustment_cap_reasons_are_specific_and_part_of_equality() {
        // Real derivation: unsupported verdicts carry the backend-specific
        // reason, not an empty/placeholder string.
        let gdi = GdiBackend.probe("EDID-001");
        let gdi_sat = gdi
            .iter()
            .find(|c| c.adjustment == ADJUSTMENT_SATURATION)
            .unwrap();
        let gdi_reason = match gdi_sat.cap {
            AdjustmentCap::Unsupported(reason) => reason,
            other => panic!("expected unsupported saturation, got {other:?}"),
        };
        assert!(
            gdi_reason.to_lowercase().contains("saturation"),
            "reason must name the control: {gdi_reason:?}"
        );

        let nvapi = NvapiBackend.probe("EDID-001");
        let nvapi_sat = nvapi
            .iter()
            .find(|c| c.adjustment == ADJUSTMENT_SATURATION)
            .unwrap();
        match nvapi_sat.cap {
            AdjustmentCap::Unsupported(reason) => assert!(
                reason.to_lowercase().contains("nvapi"),
                "reason must name the backend: {reason:?}"
            ),
            other => panic!("expected unsupported saturation, got {other:?}"),
        }

        // The carried reason is part of equality: different reasons are
        // different capabilities (the old test only compared a value to
        // itself and could never fail on derivation).
        assert_eq!(
            AdjustmentCap::Unsupported("no control"),
            AdjustmentCap::Unsupported("no control")
        );
        assert_ne!(
            AdjustmentCap::Unsupported("no control"),
            AdjustmentCap::Unsupported("different reason")
        );
        assert_ne!(AdjustmentCap::Supported, AdjustmentCap::Unsupported("x"));
    }

    #[test]
    fn adjustment_names_are_distinct_and_stable() {
        let names = [
            ADJUSTMENT_GAMMA,
            ADJUSTMENT_BRIGHTNESS,
            ADJUSTMENT_CONTRAST,
            ADJUSTMENT_RGB_GAINS,
            ADJUSTMENT_SATURATION,
            ADJUSTMENT_VIBRANCE,
            ADJUSTMENT_HUE,
        ];
        for (i, a) in names.iter().enumerate() {
            for b in names.iter().skip(i + 1) {
                assert_ne!(a, b, "adjustment names must be unique");
            }
        }
        assert_eq!(ADJUSTMENT_GAMMA, "gamma");
        assert_eq!(ADJUSTMENT_SATURATION, "saturation");
    }

    // — Backend identity + probe ————————————————————————————————————————————

    #[test]
    fn backend_ids_are_stable() {
        assert_eq!(NvapiBackend.id(), "nvapi");
        assert_eq!(GdiBackend.id(), "gdi");
    }

    #[test]
    fn nvapi_probe_reports_saturation_unsupported_vibrance_supported() {
        let caps = NvapiBackend.probe("EDID-001");
        let sat = caps
            .iter()
            .find(|c| c.adjustment == ADJUSTMENT_SATURATION)
            .unwrap();
        assert!(matches!(sat.cap, AdjustmentCap::Unsupported(_)));
        let vib = caps
            .iter()
            .find(|c| c.adjustment == ADJUSTMENT_VIBRANCE)
            .unwrap();
        assert_eq!(vib.cap, AdjustmentCap::Supported);
        let gamma = caps
            .iter()
            .find(|c| c.adjustment == ADJUSTMENT_GAMMA)
            .unwrap();
        assert_eq!(gamma.cap, AdjustmentCap::Supported);
    }

    #[test]
    fn gdi_probe_reports_vibrance_hue_saturation_unsupported() {
        let caps = GdiBackend.probe("EDID-001");
        for name in [ADJUSTMENT_SATURATION, ADJUSTMENT_VIBRANCE, ADJUSTMENT_HUE] {
            let c = caps.iter().find(|c| c.adjustment == name).unwrap();
            assert!(matches!(c.cap, AdjustmentCap::Unsupported(_)), "{name} unsupported");
        }
        let gamma = caps
            .iter()
            .find(|c| c.adjustment == ADJUSTMENT_GAMMA)
            .unwrap();
        assert_eq!(gamma.cap, AdjustmentCap::Supported);
    }
}
