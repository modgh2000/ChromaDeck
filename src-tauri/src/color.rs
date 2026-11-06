// -- Per-monitor colour apply (ICC + OS gamma ramp) -----------------------
// Windows-only. Applies ICC profile first, then gamma/RGB overlay on top.
// All hardware calls abstracted behind the `ColorApi` trait for testability.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{CreateDCW, DeleteDC, HDC};
use windows::Win32::UI::ColorSystem::GetDeviceGammaRamp;

use crate::backend::BackendRegistry;
use crate::nvapi::{display_id_for_device, fns, resolve_device_name, NvColorApi};

// -- ApplyResult -----------------------------------------------------------

/// Result of applying a preset to a monitor.
///
/// The four fields below are the original wire contract and stay unchanged.
/// Per-adjustment detail lives in [`ApplyOutcome`], which serializes these
/// fields flat (`#[serde(flatten)]`) plus an additive `adjustments` array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyResult {
    pub icc_applied: bool,
    pub gamma_applied: bool,
    pub vibrance_applied: bool,
    pub error: Option<String>,
}

/// Status of one adjustment in an apply attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdjustmentStatus {
    /// The backend accepted the write.
    Applied,
    /// Deliberately not attempted (unsupported by the backend, or neutral so
    /// there is nothing to change).
    Skipped,
    /// Attempted and reported a failure.
    Failed,
}

/// Per-adjustment outcome, serialized inside [`ApplyOutcome::adjustments`].
///
/// `verified` is honest about read-back: apply paths report accepted writes,
/// not panel read-back (Reset is the path that verifies by read-back). A
/// backend that gains read-back verification can set it true per adjustment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdjustmentOutcome {
    pub adjustment: String,
    pub status: AdjustmentStatus,
    #[serde(default)]
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Apply response: the legacy [`ApplyResult`] shape plus additive
/// per-adjustment detail. When `adjustments` is empty it is omitted, so the
/// serialized shape is byte-for-byte the legacy contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyOutcome {
    #[serde(flatten)]
    pub result: ApplyResult,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adjustments: Vec<AdjustmentOutcome>,
}

impl ApplyOutcome {
    fn legacy(result: ApplyResult) -> Self {
        ApplyOutcome {
            result,
            adjustments: Vec::new(),
        }
    }
}

#[allow(dead_code)]
impl ApplyResult {
    pub fn offline() -> Self {
        ApplyResult {
            icc_applied: false,
            gamma_applied: false,
            vibrance_applied: false,
            error: Some("monitor is offline".into()),
        }
    }

    pub fn success() -> Self {
        ApplyResult {
            icc_applied: true,
            gamma_applied: true,
            vibrance_applied: true,
            error: None,
        }
    }
}

// -- Gamma engine selection -----------------------------------------------

/// Engine used to apply gamma to a display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GammaEngine {
    Nvapi,
    Gdi,
}

/// Pure engine selector for testability.
fn engine_for_flags(nvapi_ok: bool) -> GammaEngine {
    if nvapi_ok {
        GammaEngine::Nvapi
    } else {
        GammaEngine::Gdi
    }
}

/// Select the gamma engine for a given display by probing NVAPI availability.
pub(crate) fn gamma_engine(edid_id: &str) -> GammaEngine {
    let nvapi_ok = fns()
        .and_then(|f| {
            resolve_device_name(edid_id)
                .and_then(|n| display_id_for_device(f, &n).ok())
                .map(|_| ())
        })
        .is_some();
    engine_for_flags(nvapi_ok)
}

// -- Injectable API trait -------------------------------------------------

/// Abstract colour-api so that tests never need a real display.
pub trait ColorApi {
    /// Check whether the monitor identified by `edid_id` is connected.
    fn is_connected(&self, edid_id: &str) -> bool;

    /// Install + associate an ICC profile for the monitor.
    fn associate_icc(&self, edid_id: &str, profile_path: &str) -> Result<(), String>;

    /// Set the OS gamma ramp for the monitor.
    fn set_gamma_ramp(
        &self,
        edid_id: &str,
        brightness: f64,
        contrast: f64,
        rgb_gains: [f64; 3],
        gamma: f64,
    ) -> Result<(), String>;

    /// Read back the live OS gamma ramp (3×256 WORDs). Used to verify a
    /// reset actually landed instead of reporting blind success.
    fn read_gamma_ramp(&self, edid_id: &str) -> Result<[u16; 256 * 3], String>;
}

// -- Real implementation (Win32) ------------------------------------------

/// Production API that talks to real hardware via Win32 / GDI / Mscms.
pub struct RealColorApi;

impl RealColorApi {
    /// Build a full ICC profile path from the store's profiles directory.
    pub fn profile_path(store_profiles_dir: &str, icc_filename: &str) -> PathBuf {
        PathBuf::from(store_profiles_dir).join(icc_filename)
    }

    /// Find the display device name (`\\.\DISPLAY1`) for a given EDID.
    fn device_name_for_edid(edid_id: &str) -> Option<String> {
        let monitors = crate::monitor::list_monitors();
        monitors
            .into_iter()
            .find(|m| m.edid_id == edid_id && !m.device_name.is_empty())
            .map(|m| m.device_name)
    }

    /// Reject ramps no driver will accept: a channel peaking at 0 (brightness
    /// 0 blanks the display) is refused by `SetDeviceGammaRamp`, so fail fast
    /// with an actionable message instead of a cryptic Win32 error.
    /// Returns the error message when blank, `None` when appliable.
    /// Pure function (no hardware) so it is unit-testable.
    pub fn blank_channel_error(ramp: &[u16; 256 * 3]) -> Option<String> {
        for ch in 0..3 {
            if ramp[ch * 256 + 255] == 0 {
                return Some(
                    "ramp peak is 0 (brightness 0 blanks the display, which \
                        this driver rejects); raise Brightness above 0"
                        .into(),
                );
            }
        }
        None
    }
}

impl ColorApi for RealColorApi {
    fn is_connected(&self, edid_id: &str) -> bool {
        crate::monitor::list_monitors()
            .iter()
            .any(|m| m.edid_id == edid_id && m.connected)
    }

    fn associate_icc(&self, edid_id: &str, profile_path: &str) -> Result<(), String> {
        use windows::Win32::UI::ColorSystem::{
            AssociateColorProfileWithDeviceW, InstallColorProfileW,
        };

        let device_name = Self::device_name_for_edid(edid_id)
            .ok_or_else(|| format!("no display device found for EDID {edid_id}"))?;

        // Encode paths to UCS-2 (wide strings).
        let wide_path: Vec<u16> = OsString::from(profile_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let wide_device: Vec<u16> = OsString::from(&device_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // Install the ICC profile into the system colour store.
        // SAFETY: InstallColorProfileW is a straightforward Mscms call.
        let _ = unsafe {
            InstallColorProfileW(
                PCWSTR::null(),
                PCWSTR::from_raw(wide_path.as_ptr()),
            )
        };

        // Associate the profile with the device.
        // SAFETY: AssociateColorProfileWithDeviceW links profile -> device.
        let associated: bool = unsafe {
            AssociateColorProfileWithDeviceW(
                PCWSTR::null(),
                PCWSTR::from_raw(wide_path.as_ptr()),
                PCWSTR::from_raw(wide_device.as_ptr()),
            )
            .as_bool()
        };

        if !associated {
            return Err(format!(
                "failed to associate ICC profile with {device_name}"
            ));
        }

        Ok(())
    }

    fn set_gamma_ramp(
        &self,
        edid_id: &str,
        brightness: f64,
        contrast: f64,
        rgb_gains: [f64; 3],
        gamma: f64,
    ) -> Result<(), String> {
        use windows::Win32::UI::ColorSystem::SetDeviceGammaRamp;

        let device_name = Self::device_name_for_edid(edid_id)
            .ok_or_else(|| format!("no display device found for EDID {edid_id}"))?;

        // Create a device context for the target monitor.
        let hdc = open_display_dc(&device_name)?;

        // Build the gamma ramp.
        let ramp = build_gamma_ramp(brightness, contrast, rgb_gains, gamma);

        // Fail fast on blank ramps (see blank_channel_error) before touching
        // the driver, so the user gets an actionable message.
        if let Some(msg) = Self::blank_channel_error(&ramp) {
            unsafe { let _ = DeleteDC(hdc); };
            return Err(msg);
        }

        // SAFETY: SetDeviceGammaRamp writes the ramp into the display driver.
        let ok: bool = unsafe { SetDeviceGammaRamp(hdc, &ramp as *const _ as _).as_bool() };
        // Capture the Win32 error immediately: DeleteDC below may overwrite it.
        let last_error = std::io::Error::last_os_error();

        // Cleanup DC.
        // SAFETY: DeleteDC is safe after a successful CreateDCW.
        unsafe { let _ = DeleteDC(hdc); };

        if !ok {
            Err(format!(
                "SetDeviceGammaRamp failed for {device_name} (win32 error {last_error})"
            ))
        } else {
            Ok(())
        }
    }

    fn read_gamma_ramp(&self, edid_id: &str) -> Result<[u16; 256 * 3], String> {
        let device_name = Self::device_name_for_edid(edid_id)
            .ok_or_else(|| format!("no display device found for EDID {edid_id}"))?;
        read_gamma_ramp(&device_name)
    }
}

// -- Gamma ramp builder ---------------------------------------------------

/// Build a 3×256-WORD gamma ramp from preset parameters.
///
/// Ramp layout expected by `SetDeviceGammaRamp`:
///   `ramp[0..255]`   – red channel
///   `ramp[256..511]` – green channel
///   `ramp[512..767]` – blue channel
///
/// Formula (per channel, with gain):
///   normalized = i / 255.0
///   corrected = normalized.powf(gamma)
///   contrasted = (corrected - 0.5) * contrast + 0.5
///   with_brightness = contrasted * brightness
///   output = with_brightness * gain
///   ramp[i] = clamp(output, 0, 1) * 65535
/// Minimum per-channel peak (index 255) accepted by display drivers.
///
/// Observed on NVIDIA (RTX 3050, Windows 11, `\\.\DISPLAY5`): `CreateDCW`
/// succeeds and full-range ramps apply fine, but `SetDeviceGammaRamp`
/// returns FALSE whenever any channel's last entry is below ~0x7F00-0x7FFF
/// (probed: 30720 rejected, 32767 accepted). Dim presets whose
/// brightness × contrast compress white below half (e.g. 0.5 × 0.75 = 0.375
/// -> 24576) were therefore rejected with "SetDeviceGammaRamp failed".
/// Rescaling such channels so the peak reaches this floor yields the
/// closest ramp the driver accepts (linear rescale: shape and order
/// preserved, no clipping possible since the peak lands exactly on the
/// floor). Channels already at/above the floor, and all-zero ramps
/// (brightness 0), are left untouched.
const MIN_CHANNEL_PEAK: u16 = 0x8000;

pub(crate) fn build_gamma_ramp(
    brightness: f64,
    contrast: f64,
    rgb_gains: [f64; 3],
    gamma: f64,
) -> [u16; 256 * 3] {
    let mut ramp = [0u16; 256 * 3];

    for i in 0..256 {
        let mut v = i as f64 / 255.0;

        // Gamma curve
        v = v.powf(gamma);

        // Contrast (stretch/squash around 0.5)
        v = (v - 0.5) * contrast + 0.5;

        // Brightness
        v *= brightness;

        // Clamp and scale to 16-bit
        v = v.clamp(0.0, 1.0);
        let base = (v * 65535.0) as u16;

        // Per-channel gain
        ramp[i] = ((base as f64 * rgb_gains[0]).round() as u16).min(65535);
        ramp[256 + i] = ((base as f64 * rgb_gains[1]).round() as u16).min(65535);
        ramp[512 + i] = ((base as f64 * rgb_gains[2]).round() as u16).min(65535);
    }

    // Enforce the driver-accepted peak floor per channel (see above).
    for ch in 0..3 {
        let peak = ramp[ch * 256 + 255];
        if peak > 0 && peak < MIN_CHANNEL_PEAK {
            let scale = MIN_CHANNEL_PEAK as f64 / peak as f64;
            for i in 0..256 {
                ramp[ch * 256 + i] =
                    ((ramp[ch * 256 + i] as f64 * scale).round() as u16).min(65535);
            }
        }
    }

    ramp
}

// -- Shared DC / read helpers (enforcer) ----------------------------


/// Open a device context for a display device. Shared by set/read paths.
fn open_display_dc(device_name: &str) -> Result<HDC, String> {
    let wide_device: Vec<u16> = OsString::from(device_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: CreateDCW for a display device returns the monitor's DC.
    let hdc: HDC = unsafe {
        CreateDCW(
            PCWSTR::from_raw(windows::core::w!("DISPLAY").as_ptr()),
            PCWSTR::from_raw(wide_device.as_ptr()),
            None,
            None,
        )
    };
    if hdc.is_invalid() {
        return Err(format!("failed to create DC for {device_name}"));
    }
    Ok(hdc)
}

/// Read the live gamma ramp for a display device. Used by the enforcer's
/// drift check. Hardware-only; verified live in Task 6.
pub(crate) fn read_gamma_ramp(device_name: &str) -> Result<[u16; 256 * 3], String> {
    let hdc = open_display_dc(device_name)?;
    let mut ramp = [0u16; 256 * 3];
    // SAFETY: GetDeviceGammaRamp fills 768 WORDs on success.
    let ok: bool = unsafe { GetDeviceGammaRamp(hdc, &mut ramp as *mut _ as _).as_bool() };
    // SAFETY: DeleteDC is safe after a successful CreateDCW.
    unsafe { let _ = DeleteDC(hdc); };
    if !ok {
        return Err(format!("GetDeviceGammaRamp failed for {device_name}"));
    }
    Ok(ramp)
}

// -- Shared apply core (gamma + vibrance, no ICC) -------------------------

/// Expected identity ramp: exactly what `set_gamma_ramp` builds for
/// neutral parameters. Read-backs are compared against this byte-exact
/// (the OS LUT stores what was written; any deviation is real signal).
pub(crate) fn identity_ramp() -> [u16; 256 * 3] {
    build_gamma_ramp(1.0, 1.0, [1.0, 1.0, 1.0], 1.0)
}

/// Best-effort GDI identity purge, shared by apply (before NVAPI writes)
/// and reset (NVAPI branch). Returns the error text on failure; callers
/// append it without failing (the driver write is authoritative).
pub(crate) fn gdi_identity_purge(api: &dyn ColorApi, edid_id: &str) -> Option<String> {
    api.set_gamma_ramp(edid_id, 1.0, 1.0, [1.0, 1.0, 1.0], 1.0)
        .err()
        .map(|e| format!("gdi-purge: {e}"))
}

/// Apply driver-level color state (gamma LUT + NVAPI vibrance/hue),
/// without ICC association. Shared by manual Apply and the enforcer.
pub fn apply_color(
    api: &dyn ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    preset: &crate::store::Preset,
    target_edid: &str,
) -> ApplyResult {
    apply_color_with_backend(api, nv, preset, target_edid).0
}

/// Shared apply core that also names the backend that handled the display,
/// so per-adjustment reporting can use the same capability table the UI shows.
fn apply_color_with_backend(
    api: &dyn ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    preset: &crate::store::Preset,
    target_edid: &str,
) -> (ApplyResult, &'static str) {
    if !api.is_connected(target_edid) {
        return (ApplyResult::offline(), "offline");
    }

    // Backend selection is delegated to the registry: the selected backend
    // (NVAPI, Intel, or GDI) owns the full driver-level pipeline for the display.
    let registry = BackendRegistry::new();
    let backend = registry.select(target_edid);
    (
        backend.apply(api, nv, preset, target_edid),
        backend.id(),
    )
}

// -- Per-adjustment reporting --------------------------------------------

fn applied(adjustment: &str) -> AdjustmentOutcome {
    AdjustmentOutcome {
        adjustment: adjustment.to_string(),
        status: AdjustmentStatus::Applied,
        verified: false,
        reason: None,
    }
}

fn skipped(adjustment: &str, reason: impl Into<String>) -> AdjustmentOutcome {
    AdjustmentOutcome {
        adjustment: adjustment.to_string(),
        status: AdjustmentStatus::Skipped,
        verified: false,
        reason: Some(reason.into()),
    }
}

fn failed(adjustment: &str, reason: impl Into<String>) -> AdjustmentOutcome {
    AdjustmentOutcome {
        adjustment: adjustment.to_string(),
        status: AdjustmentStatus::Failed,
        verified: false,
        reason: Some(reason.into()),
    }
}

/// Outcome for a requested vibrance-family adjustment whose write flag is
/// false: prefer a real vibrance write error, then a static unsupported reason,
/// then a generic honest failure.
fn optional_write_outcome(
    backend_id: &str,
    adjustment: &str,
    vibrance_error: &Option<String>,
    result: &ApplyResult,
) -> AdjustmentOutcome {
    if let Some(reason) = vibrance_error {
        return failed(adjustment, reason.clone());
    }
    if let Some(reason) = capability_reason(backend_id, adjustment) {
        return skipped(adjustment, reason);
    }
    failed(
        adjustment,
        result
            .error
            .clone()
            .unwrap_or_else(|| "backend did not confirm this adjustment".to_string()),
    )
}

/// Look up the static capability reason for an adjustment on a backend.
/// Uses the same tables `get_display_capabilities` serves the editor.
fn capability_reason(backend_id: &str, adjustment: &str) -> Option<&'static str> {
    crate::capabilities::capabilities_for_backend(backend_id, true)
        .adjustments
        .into_iter()
        .find(|c| c.adjustment == adjustment)
        .and_then(|c| c.reason)
}

/// Derive the per-adjustment report for one backend apply.
///
/// Honest rules:
/// - the gamma family (gamma, brightness, contrast, rgb_gains) is one pipeline
///   write on every backend: applied together or failed together;
/// - vibrance/hue are only reported when the preset asks for a non-neutral
///   value (neutral skips are not failures) – a failure reported by the
///   vibrance write is a `Failed`, an unsupported backend is a `Skipped`;
/// - saturation is `Applied` only on Intel (the one backend with a desktop
///   saturation transform), otherwise reported `Skipped` with the reason;
/// - applied writes are `verified: false`: the apply path does not read the
///   panel back (Reset and Probe are the verified paths).
pub fn adjustment_outcomes(
    backend_id: &str,
    preset: &crate::store::Preset,
    result: &ApplyResult,
) -> Vec<AdjustmentOutcome> {
    use crate::backend::{
        ADJUSTMENT_BRIGHTNESS, ADJUSTMENT_CONTRAST, ADJUSTMENT_GAMMA, ADJUSTMENT_HUE,
        ADJUSTMENT_RGB_GAINS, ADJUSTMENT_SATURATION, ADJUSTMENT_VIBRANCE,
    };
    use crate::nvapi::{HUE_NEUTRAL, VIBRANCE_NEUTRAL};

    let mut out = Vec::new();

    // Gamma family – delivered as one ramp/pipeline write.
    let gamma_failure = if result.gamma_applied {
        None
    } else {
        Some(
            result
                .error
                .clone()
                .unwrap_or_else(|| "backend did not confirm this adjustment".to_string()),
        )
    };
    for adjustment in [
        ADJUSTMENT_GAMMA,
        ADJUSTMENT_BRIGHTNESS,
        ADJUSTMENT_CONTRAST,
        ADJUSTMENT_RGB_GAINS,
    ] {
        out.push(match &gamma_failure {
            None => applied(adjustment),
            Some(reason) => failed(adjustment, reason.clone()),
        });
    }

    // Saturation – no backend except Intel applies the desktop saturation
    // transform. Neutral saturation requests nothing, so stay silent.
    const SATURATION_NEUTRAL: f64 = 50.0;
    if preset.saturation != SATURATION_NEUTRAL {
        if backend_id == "intel" {
            out.push(match &gamma_failure {
                None => applied(ADJUSTMENT_SATURATION),
                Some(reason) => failed(ADJUSTMENT_SATURATION, reason.clone()),
            });
        } else {
            out.push(skipped(
                ADJUSTMENT_SATURATION,
                capability_reason(backend_id, ADJUSTMENT_SATURATION)
                    .unwrap_or("no desktop saturation control"),
            ));
        }
    }

    // Vibrance / hue – only when requested (non-neutral).
    let vibrance_requested = preset.vibrance != VIBRANCE_NEUTRAL;
    let hue_requested = preset.hue_deg != HUE_NEUTRAL;

    // GDI reaches vibrance through the NVAPI overlay: a failure there is a
    // real attempted failure, not an unsupported skip, so prefer the write
    // error when it names vibrance.
    let vibrance_error = result
        .error
        .clone()
        .filter(|e| e.to_lowercase().contains("vibrance"));

    if vibrance_requested {
        out.push(if result.vibrance_applied {
            applied(ADJUSTMENT_VIBRANCE)
        } else {
            optional_write_outcome(
                backend_id,
                ADJUSTMENT_VIBRANCE,
                &vibrance_error,
                result,
            )
        });
    }

    if hue_requested {
        // Intel delivers hue inside the pixtx colour matrix, written as part
        // of the same pipeline SET as the gamma family (tracked by
        // `gamma_applied`) – `vibrance_applied` is always false on Intel and
        // must not be used to judge hue. NVIDIA/GDI deliver hue through the
        // DVC vibrance write.
        if backend_id == "intel" {
            out.push(match &gamma_failure {
                None => applied(ADJUSTMENT_HUE),
                Some(reason) => failed(ADJUSTMENT_HUE, reason.clone()),
            });
        } else {
            out.push(if result.vibrance_applied {
                applied(ADJUSTMENT_HUE)
            } else {
                optional_write_outcome(backend_id, ADJUSTMENT_HUE, &vibrance_error, result)
            });
        }
    }

    out
}

// -- apply_preset (ICC + shared apply_color) -----------------------

/// Apply a preset to a target monitor.
///
/// Precedence: ICC first, then gamma/RGB overlay on top.
/// Returns an `ApplyResult` summarising what succeeded / failed.
// The command layer uses `apply_preset_detailed` (legacy fields + additive
// per-adjustment detail); this legacy projection stays for tests and internal
// callers that only need the original four fields.
#[allow(dead_code)]
pub fn apply_preset(
    api: &dyn ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    preset: &crate::store::Preset,
    target_edid: &str,
    store_profiles_dir: &str,
) -> ApplyResult {
    apply_preset_detailed(api, nv, preset, target_edid, store_profiles_dir).result
}

/// Same apply flow as [`apply_preset`], plus the additive per-adjustment
/// report. The legacy fields on `ApplyOutcome::result` behave exactly as
/// before; the command layer returns this shape to the UI.
pub fn apply_preset_detailed(
    api: &dyn ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    preset: &crate::store::Preset,
    target_edid: &str,
    store_profiles_dir: &str,
) -> ApplyOutcome {
    // Step 1 – monitor connectivity check
    if !api.is_connected(target_edid) {
        return ApplyOutcome::legacy(ApplyResult::offline());
    }

    let mut icc_applied = false;
    let mut icc_error: Option<String> = None;

    // Step 2 – ICC (first)
    if !preset.icc_hash.is_empty() {
        let profile_path = RealColorApi::profile_path(store_profiles_dir, &preset.icc_filename);
        let profile_path_str = profile_path.to_string_lossy().to_string();
        match api.associate_icc(target_edid, &profile_path_str) {
            Ok(()) => icc_applied = true,
            Err(e) => {
                icc_error = Some(format!("ICC: {e}"));
            }
        }
    }

    // Step 3 – gamma + vibrance via shared core
    let (mut result, backend_id) = apply_color_with_backend(api, nv, preset, target_edid);
    result.icc_applied = icc_applied;
    let merged_error = match (icc_error.clone(), result.error.clone()) {
        (Some(a), Some(b)) => Some(format!("{a}; {b}")),
        (Some(a), None) => Some(a),
        (None, b) => b,
    };
    result.error = merged_error;

    // Step 4 – additive per-adjustment report. ICC comes first (it is the
    // first step); the rest follow the capability-table order.
    let mut adjustments = Vec::new();
    if !preset.icc_hash.is_empty() {
        adjustments.push(if icc_applied {
            applied("icc")
        } else {
            failed(
                "icc",
                icc_error
                    .clone()
                    .or_else(|| result.error.clone())
                    .unwrap_or_else(|| "ICC association failed".to_string()),
            )
        });
    }
    adjustments.extend(adjustment_outcomes(backend_id, preset, &result));

    ApplyOutcome {
        result,
        adjustments,
    }
}

/// Restore a set of displays to system defaults through the backend
/// abstraction. Used when an applied/pinned preset is removed: every display
/// that referenced it gets the same reset semantics as `reset_monitor`.
/// Returns `(edid_id, result)` pairs in input order.
pub fn restore_monitors(
    api: &dyn ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    edid_ids: &[String],
) -> Vec<(String, ApplyResult)> {
    edid_ids
        .iter()
        .map(|edid| (edid.clone(), reset_monitor(api, nv, edid)))
        .collect()
}

/// Reset a monitor to system defaults: identity gamma ramp
/// (brightness 1, contrast 1, unit RGB gains, gamma 1) plus neutral
/// vibrance (50) and hue (0). ICC associations are left untouched.
/// Vibrance is attempted even where NVAPI reports unsupported (best
/// effort, those failures swallowed); supported failures are reported.
/// Every write is verified by read-back: a panel that doesn't reflect
/// the reset becomes an actionable error instead of false success.
/// Returns an `ApplyResult` with `icc_applied: false`.
pub fn reset_monitor(
    api: &dyn ColorApi,
    nv: &dyn crate::nvapi::NvColorApi,
    edid_id: &str,
) -> ApplyResult {
    if !api.is_connected(edid_id) {
        return ApplyResult::offline();
    }

    // Backend selection is delegated to the registry: the selected backend
    // (NVAPI or GDI) owns the full reset path (gamma + vibrance + read-back).
    BackendRegistry::new()
        .select(edid_id)
        .restore(api, nv, edid_id)
}

// -- Tauri command ---------------------------------------------------

#[tauri::command]
pub fn apply_preset_cmd(
    state: tauri::State<'_, crate::store::AppStore>,
    id: String,
    target_edid: String,
) -> ApplyOutcome {
    // Read the preset from the store
    let store = match state.0.lock() {
        Ok(s) => s,
        Err(e) => {
            return ApplyOutcome::legacy(ApplyResult {
                icc_applied: false,
                gamma_applied: false,
                vibrance_applied: false,
                error: Some(format!("store lock: {e}")),
            })
        }
    };

    let preset = match store.list_presets().into_iter().find(|p| p.id == id) {
        Some(p) => p,
        None => {
            return ApplyOutcome::legacy(ApplyResult {
                icc_applied: false,
                gamma_applied: false,
                vibrance_applied: false,
                error: Some(format!("preset not found: {id}")),
            })
        }
    };

    // Build the profiles directory path from the store's data_dir
    let profiles_dir = crate::store::default_store_path().join("profiles");
    let profiles_dir_str = profiles_dir.to_string_lossy().to_string();

    // Release the store lock before the potentially long apply call
    drop(store);

    let api = RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let outcome = apply_preset_detailed(&api, &nv, &preset, &target_edid, &profiles_dir_str);

    // Record applied state on success (reacquire store lock)
    if outcome.result.error.is_none() {
        if let Ok(mut store) = state.0.lock() {
            let _ = store.record_applied(&target_edid, &id);
        }
    }

    outcome
}

/// Live hardware readout for one monitor – answers "did the last write
/// actually land?" without changing anything.
#[derive(Debug, Clone, Serialize)]
pub struct MonitorProbe {
    /// Legacy coarse engine classification ("nvapi" | "gdi").
    pub engine: String,
    /// Real backend that owns this display ("nvapi" | "intel" | "gdi"),
    /// additive so older consumers can keep reading `engine`.
    pub backend_id: String,
    pub vibrance_supported: bool,
    pub vibrance: Option<f64>,
    pub hue: Option<f64>,
    /// Peak of the live colour ramp/LUT (0..1). For Intel this is the pixtx
    /// 1D LUT, not the unrelated OS GDI ramp.
    pub ramp_peak: Option<f64>,
    /// Whether that ramp/LUT is the linear identity. For Intel this is the
    /// pixtx 1D LUT.
    pub ramp_identity: Option<bool>,
}

#[tauri::command]
pub fn probe_monitor_cmd(edid_id: String) -> Result<MonitorProbe, String> {
    let api = RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let registry = BackendRegistry::new();
    let backend = registry.select(&edid_id);
    let backend_id = backend.id();
    let engine = match gamma_engine(&edid_id) {
        GammaEngine::Nvapi => "nvapi",
        GammaEngine::Gdi => "gdi",
    };
    // Vibrance/hue are NVAPI controls; Intel reports unsupported (false) and
    // GDI probes NVAPI best-effort exactly as before.
    let supported = backend_id != "intel" && nv.supported(&edid_id);
    let (vibrance, hue) = if supported {
        match nv.levels(&edid_id) {
            Ok((v, h)) => (Some(v), Some(h)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };
    // Intel colour is driven by the pixtx 1D LUT, so reading the OS GDI ramp
    // would report "identity" while the panel is tinted. Probe the live pixtx
    // LUT instead.
    let (ramp_peak, ramp_identity) = if backend_id == "intel" {
        match crate::backend::intel::current_1dlut_summary(&edid_id) {
            Ok((peak, identity)) => (Some(peak), Some(identity)),
            Err(_) => (None, None),
        }
    } else {
        match api.read_gamma_ramp(&edid_id) {
            Ok(ramp) => {
                let peak = ramp.iter().max().copied().unwrap_or(0) as f64 / 65535.0;
                (Some(peak), Some(ramp == identity_ramp()))
            }
            Err(_) => (None, None),
        }
    };
    Ok(MonitorProbe {
        engine: engine.into(),
        backend_id: backend_id.into(),
        vibrance_supported: supported,
        vibrance,
        hue,
        ramp_peak,
        ramp_identity,
    })
}

#[tauri::command]
pub fn reset_monitor_cmd(
    state: tauri::State<'_, crate::store::AppStore>,
    edid_id: String,
) -> ApplyResult {
    let api = RealColorApi;
    let nv = crate::nvapi::RealNvapi;
    let result = reset_monitor(&api, &nv, &edid_id);

    // Clear applied record on success
    if result.error.is_none() {
        if let Ok(mut store) = state.0.lock() {
            store.clear_applied(&edid_id);
        }
    }

    result
}
