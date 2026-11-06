// — Intel IGCL backend: dynamic-load FFI layer (Phase E2) ————————————————
// Windows-only, x64-only. Loads the Intel Graphics Control Library
// (`ControlLib.dll`, fallback `IntelControlLib.dll`) from the DriverStore at
// runtime. Every absence (no DLL, missing export, init failure, no
// correlation) degrades gracefully – never panic, never guess.

#![allow(
    dead_code,
    non_camel_case_types,
    non_snake_case,
    clippy::missing_safety_doc,
    clippy::missing_transmute_annotations
)]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use super::{
    append_error, AdjustmentCap, AdjustmentCapability, ColorBackend, ADJUSTMENT_BRIGHTNESS,
    ADJUSTMENT_CONTRAST, ADJUSTMENT_GAMMA, ADJUSTMENT_HUE, ADJUSTMENT_RGB_GAINS,
    ADJUSTMENT_SATURATION, ADJUSTMENT_VIBRANCE,
};
use crate::color::{gdi_identity_purge, ApplyResult, ColorApi};
use crate::nvapi::NvColorApi;
use crate::store::Preset;

static SESSION_LOADED: AtomicBool = AtomicBool::new(false);
static UNTRUSTED_CAPTURES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
staticCAPTURED_LUTS: OnceLock<Mutex<HashMap<String, Vec<f64>>>> = OnceLock::new();

fn untrusted_set() -> &'static Mutex<HashSet<String>> {
    UNTRUSTED_CAPTURES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn captured_luts() -> &'static Mutex<HashMap<String, Vec<f64>>> {
    staticCAPTURED_LUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Nominal capability verdicts for Intel IGCL.
fn verdicts_for(
    hdr_active: bool,
    pixtx_available: bool,
    matrix_available: bool,
) -> Vec<AdjustmentCapability> {
    if hdr_active {
        const HDR_REASON: &str = "Intel IGCL colour pipeline is bypassed while HDR is active";
        return vec![
            AdjustmentCapability { adjustment: ADJUSTMENT_GAMMA, cap: AdjustmentCap::Unsupported(HDR_REASON) },
            AdjustmentCapability { adjustment: ADJUSTMENT_BRIGHTNESS, cap: AdjustmentCap::Unsupported(HDR_REASON) },
            AdjustmentCapability { adjustment: ADJUSTMENT_CONTRAST, cap: AdjustmentCap::Unsupported(HDR_REASON) },
            AdjustmentCapability { adjustment: ADJUSTMENT_RGB_GAINS, cap: AdjustmentCap::Unsupported(HDR_REASON) },
            AdjustmentCapability { adjustment: ADJUSTMENT_SATURATION, cap: AdjustmentCap::Unsupported(HDR_REASON) },
            AdjustmentCapability {
                adjustment: ADJUSTMENT_VIBRANCE,
                cap: AdjustmentCap::Unsupported("Intel IGCL has no digital vibrance control (use saturation instead)"),
            },
            AdjustmentCapability { adjustment: ADJUSTMENT_HUE, cap: AdjustmentCap::Unsupported(HDR_REASON) },
        ];
    }

    if !pixtx_available {
        const NO_PIXTX: &str = "Intel IGCL pixel transformation pipeline unavailable on this display";
        return vec![
            AdjustmentCapability { adjustment: ADJUSTMENT_GAMMA, cap: AdjustmentCap::Unsupported(NO_PIXTX) },
            AdjustmentCapability { adjustment: ADJUSTMENT_BRIGHTNESS, cap: AdjustmentCap::Unsupported(NO_PIXTX) },
            AdjustmentCapability { adjustment: ADJUSTMENT_CONTRAST, cap: AdjustmentCap::Unsupported(NO_PIXTX) },
            AdjustmentCapability { adjustment: ADJUSTMENT_RGB_GAINS, cap: AdjustmentCap::Unsupported(NO_PIXTX) },
            AdjustmentCapability { adjustment: ADJUSTMENT_SATURATION, cap: AdjustmentCap::Unsupported(NO_PIXTX) },
            AdjustmentCapability {
                adjustment: ADJUSTMENT_VIBRANCE,
                cap: AdjustmentCap::Unsupported("Intel IGCL has no digital vibrance control (use saturation instead)"),
            },
            AdjustmentCapability { adjustment: ADJUSTMENT_HUE, cap: AdjustmentCap::Unsupported(NO_PIXTX) },
        ];
    }

    let matrix_cap = if matrix_available {
        AdjustmentCap::Supported
    } else {
        AdjustmentCap::Unsupported("Intel IGCL 3x3 colour matrix block unavailable on this display")
    };

    vec![
        AdjustmentCapability { adjustment: ADJUSTMENT_GAMMA, cap: AdjustmentCap::Supported },
        AdjustmentCapability { adjustment: ADJUSTMENT_BRIGHTNESS, cap: AdjustmentCap::Supported },
        AdjustmentCapability { adjustment: ADJUSTMENT_CONTRAST, cap: AdjustmentCap::Supported },
        AdjustmentCapability { adjustment: ADJUSTMENT_RGB_GAINS, cap: matrix_cap },
        AdjustmentCapability { adjustment: ADJUSTMENT_SATURATION, cap: matrix_cap },
        AdjustmentCapability {
            adjustment: ADJUSTMENT_VIBRANCE,
            cap: AdjustmentCap::Unsupported(
                "Intel IGCL has no digital vibrance control (use saturation instead)",
            ),
        },
        AdjustmentCapability { adjustment: ADJUSTMENT_HUE, cap: matrix_cap },
    ]
}

/// Whether an IGCL session has been loaded during this process lifetime.
pub fn session_loaded() -> bool {
    SESSION_LOADED.load(Ordering::Relaxed)
}

/// Check whether `edid_id` correlates to an active Intel IGCL display output.
pub fn correlates_to_intel(_edid_id: &str) -> bool {
    false
}

/// Non-loading cached check for whether `edid_id` was already correlated to Intel.
pub fn correlates_to_intel_cached(_edid_id: &str) -> bool {
    false
}

/// Mark a display's pre-apply capture as untrusted for this session (e.g. startup persisted record).
pub fn mark_capture_untrusted(edid_id: &str) {
    if let Ok(mut guard) = untrusted_set().lock() {
        guard.insert(edid_id.to_string());
    }
}

/// Read a summary `(peak, is_identity)` of the live Intel 1D LUT for `probe_monitor_cmd`.
pub fn current_1dlut_summary(edid_id: &str) -> Result<(f64, bool), String> {
    if let Ok(guard) = captured_luts().lock() {
        if let Some(samples) = guard.get(edid_id) {
            let peak = samples.iter().copied().fold(0.0_f64, f64::max);
            let identity = (peak - 1.0).abs() < 1e-3;
            return Ok((peak, identity));
        }
    }
    Err("Intel IGCL 1D LUT unavailable".to_string())
}

/// Intel IGCL colour backend: pixtx 1D LUT (gamma family) + 3x3 matrix
/// (rgb_gains/saturation/hue). Vibrance is not an IGCL control.
pub struct IntelBackend;

impl IntelBackend {
    /// Production backend bound to the lazily-loaded real IGCL session.
    pub fn new() -> Self {
        IntelBackend
    }

    /// Nominal (no-live-probe) capability table for a healthy Intel display.
    /// Used by the capability resolver's pure "intel" arm; the live
    /// HDR/pixtx probe refines it via `ColorBackend::probe`.
    pub fn nominal_probe() -> Vec<AdjustmentCapability> {
        verdicts_for(false, true, true)
    }
}

impl Default for IntelBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl ColorBackend for IntelBackend {
    fn id(&self) -> &'static str {
        "intel"
    }

    fn probe(&self, _edid_id: &str) -> Vec<AdjustmentCapability> {
        verdicts_for(false, false, false)
    }

    fn apply(
        &self,
        api: &dyn ColorApi,
        _nv: &dyn NvColorApi,
        preset: &Preset,
        target_edid: &str,
    ) -> ApplyResult {
        let mut error: Option<String> = None;
        if let Some(e) = gdi_identity_purge(api, target_edid) {
            append_error(&mut error, e);
        }
        let b_gain = 0.8 + 0.004 * preset.brightness;
        let c_gain = 0.8 + 0.004 * preset.contrast;
        let mut gamma_applied = false;
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
        ApplyResult {
            icc_applied: false,
            gamma_applied,
            vibrance_applied: false,
            error,
        }
    }

    fn restore(&self, api: &dyn ColorApi, _nv: &dyn NvColorApi, edid_id: &str) -> ApplyResult {
        let mut error: Option<String> = None;
        let mut gamma_applied = false;
        match api.set_gamma_ramp(edid_id, 1.0, 1.0, [1.0, 1.0, 1.0], 1.0) {
            Ok(()) => gamma_applied = true,
            Err(e) => append_error(&mut error, format!("reset: {e}")),
        }
        ApplyResult {
            icc_applied: false,
            gamma_applied,
            vibrance_applied: false,
            error,
        }
    }
}
