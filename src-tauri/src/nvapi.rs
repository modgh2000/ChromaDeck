// --- NVAPI vibrance/hue (dynamic load, no SDK) -------------------------
// Windows-only, x64-only. Loads nvapi64.dll at runtime; every absence
// (no DLL, init failure, unsupported display) degrades to false/Err.
//
// QueryInterface IDs + struct layouts transcribed from:
//   https://github.com/falahati/NvAPIWrapper (MIT) — DisplayApi.cs,
//     Delegates/Display.cs, Display/Structures/PrivateDisplay{ DVCInfoEx,
//     HUEInfo }.cs, Helpers/FunctionId.cs
// Flow/init + display-id from:
//   https://github.com/NVIDIA/nvapi — Sample_Code/DisplayColorControl/
//     NVHelper.cpp
//
// Items below are consumed by Task 3 (color.rs, lib.rs); dead_code warnings
// are expected until then.

#![allow(dead_code, non_camel_case_types, private_interfaces)]

use std::ffi::{c_char, c_void, CString};
#[cfg(test)]
use std::sync::Mutex;
use std::sync::OnceLock;
use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::{FreeLibrary, HMODULE};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

pub const VIBRANCE_NEUTRAL: f64 = 50.0;
pub const HUE_NEUTRAL: f64 = 0.0;

// --- QueryInterface IDs (from NvAPIWrapper Helpers/FunctionId.cs) ---------

const NVAPI_INITIALIZE: u32 = 0x0150E828;
const NVAPI_GET_ERROR_MESSAGE: u32 = 0x6C2D048C;
const NVAPI_DISP_GET_DISPLAY_ID_BY_DISPLAY_NAME: u32 = 0xAE457190;
const NVAPI_GET_DVC_INFO_EX: u32 = 0x0E45002D;
const NVAPI_SET_DVC_LEVEL_EX: u32 = 0x4A82C2B1;
const NVAPI_GET_HUE_INFO: u32 = 0x95B64341;
const NVAPI_SET_HUE_ANGLE: u32 = 0x0F5A0F22C;
const NVAPI_SET_TARGET_GAMMA: u32 = 0x7082A053;
const NVAPI_GET_LUID_FROM_DISPLAY_ID: u32 = 0xD4A859F2;

type NvAPI_ShortString = [c_char; 64];
type NvStatus = i32;

pub(crate) const NVAPI_OK: NvStatus = 0;

// --- Private NVAPI struct layouts (from NvAPIWrapper, C# StructLayout Pack=8) ---

/// NVAPI struct version encoding: sizeof(struct) | (1 << 16).
/// Proven on hardware (RTX 3050, driver 610.74): DvcInfoEx (20 bytes)
/// requires 0x10014; HueInfo (12 bytes) requires 0x1000C.
fn nvapi_version<T>() -> u32 {
    (std::mem::size_of::<T>() as u32) | (1 << 16)
}

/// NV_PRIVATE_DISPLAY_DVC_INFO_EX - vibrance levels (0..100).
#[repr(C)]
struct DvcInfoEx {
    version: u32,
    current_level: i32,
    minimum_level: i32,
    maximum_level: i32,
    default_level: i32,
}

/// NV_PRIVATE_DISPLAY_HUE_INFO - hue angle (0..359 degrees).
#[repr(C)]
struct HueInfo {
    version: u32,
    current_angle: i32,
    default_angle: i32,
}

// --- Function pointers (resolved once via NvAPI_QueryInterface) ---------

pub(crate) struct NvapiFns {
    /// Keep the HMODULE alive for the process lifetime (never freed).
    pub(crate) _lib: HMODULE,
    pub(crate) initialize: unsafe extern "system" fn() -> NvStatus,
    pub(crate) get_error_message: unsafe extern "system" fn(NvStatus, *mut NvAPI_ShortString),
    pub(crate) get_display_id: unsafe extern "system" fn(*const c_char, *mut u32) -> NvStatus,
    pub(crate) get_dvc_info_ex:
        unsafe extern "system" fn(display_handle: *mut c_void, output_id: u32, info: *mut DvcInfoEx) -> NvStatus,
    pub(crate) set_dvc_level_ex:
        unsafe extern "system" fn(display_handle: *mut c_void, output_id: u32, info: *const DvcInfoEx) -> NvStatus,
    pub(crate) get_hue_info:
        unsafe extern "system" fn(display_handle: *mut c_void, output_id: u32, info: *mut HueInfo) -> NvStatus,
    pub(crate) set_hue_angle: unsafe extern "system" fn(display_handle: *mut c_void, output_id: u32, angle: i32) -> NvStatus,
    // --- New entries for Task 2 -----------------------------------------
    pub(crate) set_gamma:
        unsafe extern "system" fn(u32, *const crate::nvgamma::NvGammaRampEx) -> NvStatus,
    pub(crate) get_luid:
        unsafe extern "system" fn(u32, u32, *mut windows::core::GUID) -> NvStatus,
}

// SAFETY: resolved once at startup; function pointers stay valid for the
// process lifetime and are only ever called (never mutated).
unsafe impl Send for NvapiFns {}
unsafe impl Sync for NvapiFns {}

static NVAPI: OnceLock<Option<NvapiFns>> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Load and initialize NVAPI from the named library. `None` on ANY failure
/// (missing DLL, missing export, init failure) - callers degrade gracefully.
#[allow(clippy::missing_transmute_annotations)]
pub(crate) fn load_nvapi(library_name: &str) -> Option<NvapiFns> {
    // SAFETY: LoadLibraryW is safe with a valid wide string.
    let wide_name = wide(library_name);
    let lib = unsafe { LoadLibraryW(PCWSTR::from_raw(wide_name.as_ptr())) };
    let lib = match lib {
        Ok(h) => h,
        Err(_) => return None,
    };
    if lib.is_invalid() {
        return None;
    }

    // SAFETY: GetProcAddress retrieves the exported address.
    let query_interface_ptr = unsafe {
        GetProcAddress(lib, PCSTR::from_raw(
            "nvapi_QueryInterface\0".as_ptr(),
        ))
    };
    if query_interface_ptr.is_none() {
        // SAFETY: FreeLibrary is safe here.
        unsafe { let _ = FreeLibrary(lib); };
        return None;
    }
    let query_interface_fn = query_interface_ptr.unwrap();
    // SAFETY: We trust the resolved function pointer to have the correct signature.
    let query_interface: unsafe extern "system" fn(u32) -> *mut c_void =
        unsafe { std::mem::transmute(query_interface_fn) };

    // Resolve each function pointer by ID.
    macro_rules! resolve {
        ($id:expr) => {{
            let ptr = query_interface($id);
            if ptr.is_null() {
                return None;
            }
            ptr
        }};
    }

    let fns = NvapiFns {
        _lib: lib,
        initialize: unsafe { std::mem::transmute(resolve!(NVAPI_INITIALIZE)) },
        get_error_message: unsafe { std::mem::transmute(resolve!(NVAPI_GET_ERROR_MESSAGE)) },
        get_display_id: unsafe { std::mem::transmute(resolve!(NVAPI_DISP_GET_DISPLAY_ID_BY_DISPLAY_NAME)) },
        get_dvc_info_ex: unsafe { std::mem::transmute(resolve!(NVAPI_GET_DVC_INFO_EX)) },
        set_dvc_level_ex: unsafe { std::mem::transmute(resolve!(NVAPI_SET_DVC_LEVEL_EX)) },
        get_hue_info: unsafe { std::mem::transmute(resolve!(NVAPI_GET_HUE_INFO)) },
        set_hue_angle: unsafe { std::mem::transmute(resolve!(NVAPI_SET_HUE_ANGLE)) },
        set_gamma: unsafe { std::mem::transmute(resolve!(NVAPI_SET_TARGET_GAMMA)) },
        get_luid: unsafe { std::mem::transmute(resolve!(NVAPI_GET_LUID_FROM_DISPLAY_ID)) },
    };

    // SAFETY: NvAPI Initialize is safe to call once.
    let init_status = unsafe { (fns.initialize)() };
    if init_status != NVAPI_OK {
        // SAFETY: FreeLibrary is safe.
        unsafe { let _ = FreeLibrary(lib); };
        return None;
    }

    Some(fns)
}

pub(crate) fn fns() -> Option<&'static NvapiFns> {
    NVAPI.get_or_init(|| load_nvapi("nvapi64.dll")).as_ref()
}

/// Whether NVAPI has already been initialised. Unlike `fns`, this never
/// loads the library, so shutdown/logging classification cannot stall on a
/// driver load.
pub(crate) fn loaded() -> bool {
    NVAPI.get().is_some_and(|fns| fns.is_some())
}

// --- NvColorApi trait (EDID-keyed, same convention as ColorApi) ---------

pub trait NvColorApi {
    /// Check whether the display identified by `edid_id` supports NVAPI
    /// vibrance/hue control.
    fn supported(&self, edid_id: &str) -> bool;
    /// Set vibrance (0-100, 50 neutral) and hue (0-359°, 0 neutral).
    fn set(&self, edid_id: &str, vibrance: f64, hue_deg: f64) -> Result<(), String>;
    /// Read back current (vibrance, hue). Used to verify a reset actually
    /// landed instead of reporting blind success.
    fn levels(&self, edid_id: &str) -> Result<(f64, f64), String>;
}

// --- Display-ID resolution helpers (owned by this task) -----------------

pub(crate) fn resolve_device_name(edid_id: &str) -> Option<String> {
    crate::monitor::list_monitors()
        .into_iter()
        .find(|m| m.edid_id == edid_id && !m.device_name.is_empty())
        .map(|m| m.device_name)
}

pub(crate) fn display_id_for_device(fns: &NvapiFns, device_name: &str) -> Result<u32, String> {
    let name = CString::new(device_name).map_err(|_| "display name contains nul byte".to_string())?;
    let mut id: u32 = 0;
    // SAFETY: GetDisplayIdByDisplayName writes one u32 on success.
    let status = unsafe { (fns.get_display_id)(name.as_ptr(), &mut id) };
    if status != NVAPI_OK {
        return Err("NVAPI unavailable for this display".into());
    }
    Ok(id)
}

/// Read current (vibrance, hue) for an EDID. Used by the enforcer's drift
/// check. Hardware-only; verified live in Task 6.
pub(crate) fn read_levels(edid_id: &str) -> Result<(f64, f64), String> {
    let fns = fns().ok_or_else(|| "NVAPI unavailable for this display".to_string())?;
    let device = resolve_device_name(edid_id)
        .ok_or_else(|| "NVAPI unavailable for this display".to_string())?;
    let id = display_id_for_device(fns, &device)?;

    // Read DVC current level (vibrance)
    let mut dvc = DvcInfoEx {
        version: nvapi_version::<DvcInfoEx>(),
        current_level: 0,
        minimum_level: 0,
        maximum_level: 0,
        default_level: 0,
    };
    // SAFETY: get_dvc_info_ex writes into info on success.
    let dvc_status = unsafe { (fns.get_dvc_info_ex)(std::ptr::null_mut(), id, &mut dvc) };
    if dvc_status != NVAPI_OK {
        return Err(status_to_string(fns, dvc_status));
    }

    // Read HUE angle
    let mut hue = HueInfo {
        version: nvapi_version::<HueInfo>(),
        current_angle: 0,
        default_angle: 0,
    };
    // SAFETY: get_hue_info writes into info on success.
    let hue_status = unsafe { (fns.get_hue_info)(std::ptr::null_mut(), id, &mut hue) };
    if hue_status != NVAPI_OK {
        return Err(status_to_string(fns, hue_status));
    }

    Ok((dvc.current_level as f64, hue.current_angle as f64))
}

/// Map a non-zero NVAPI status to the error message string.
pub(crate) fn status_to_string(fns: &NvapiFns, status: NvStatus) -> String {
    let mut buf: NvAPI_ShortString = [0 as c_char; 64];
    // SAFETY: GetErrorMessage writes up to 63 chars + null into buf.
    unsafe { (fns.get_error_message)(status, &mut buf) };
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    let text = String::from_utf8_lossy(&bytes).to_string();
    format!("NVAPI call failed (nvapi 0x{status:X}): {text}")
}

// --- RealNvapi -----------------------------------------------------------

pub struct RealNvapi;

impl NvColorApi for RealNvapi {
    fn supported(&self, edid_id: &str) -> bool {
        let fns = match fns() {
            Some(f) => f,
            None => return false,
        };
        let device_name = match resolve_device_name(edid_id) {
            Some(n) => n,
            None => return false,
        };
        let display_id = match display_id_for_device(fns, &device_name) {
            Ok(id) => id,
            Err(_) => return false,
        };
        // Probe DVC - if it works, hue likely does too; both use the
        // same display path. Avoid making two calls here.
        let mut info = DvcInfoEx {
            version: nvapi_version::<DvcInfoEx>(),
            current_level: 0,
            minimum_level: 0,
            maximum_level: 0,
            default_level: 0,
        };
        // SAFETY: get_dvc_info_ex writes into info on success.
        let status = unsafe { (fns.get_dvc_info_ex)(std::ptr::null_mut(), display_id, &mut info) };
        status == NVAPI_OK
    }

    fn set(&self, edid_id: &str, vibrance: f64, hue_deg: f64) -> Result<(), String> {
        let fns = match fns() {
            Some(f) => f,
            None => return Err("NVAPI unavailable for this display".into()),
        };
        let device_name = match resolve_device_name(edid_id) {
            Some(n) => n,
            None => return Err("NVAPI unavailable for this display".into()),
        };
        let display_id = display_id_for_device(fns, &device_name)?;

        // Set DVC level (vibrance)
        let dvc_info = DvcInfoEx {
            version: nvapi_version::<DvcInfoEx>(),
            current_level: vibrance as i32,
            minimum_level: 0,
            maximum_level: 100,
            default_level: 50,
        };
        // SAFETY: set_dvc_level_ex reads info.
        let dvc_status = unsafe { (fns.set_dvc_level_ex)(std::ptr::null_mut(), display_id, &dvc_info) };
        if dvc_status != NVAPI_OK {
            return Err(status_to_string(fns, dvc_status));
        }

        // Set HUE angle
        // SAFETY: set_hue_angle reads the angle value.
        let hue_status = unsafe { (fns.set_hue_angle)(std::ptr::null_mut(), display_id, hue_deg as i32) };
        if hue_status != NVAPI_OK {
            return Err(status_to_string(fns, hue_status));
        }

        Ok(())
    }

    fn levels(&self, edid_id: &str) -> Result<(f64, f64), String> {
        read_levels(edid_id)
    }
}

// --- Tauri command (defined here, registered in lib.rs in Task 3) --------

#[tauri::command]
pub fn vibrance_supported_cmd(edid_id: String) -> bool {
    RealNvapi.supported(&edid_id)
}

// --- Mock (test double) -------------------------------------------

#[cfg(test)]
pub struct MockNvapi {
    pub calls: Mutex<Vec<(String, f64, f64)>>,
    pub supported: bool,
    pub fail_set: bool,
    /// Levels returned by `levels()`. Defaults to neutral so existing
    /// tests (which assert clean resets) keep passing.
    pub levels: (f64, f64),
    pub fail_levels: bool,
}

#[cfg(test)]
impl MockNvapi {
    pub fn new(supported: bool) -> Self {
        MockNvapi {
            calls: Mutex::new(Vec::new()),
            supported,
            fail_set: false,
            levels: (VIBRANCE_NEUTRAL, HUE_NEUTRAL),
            fail_levels: false,
        }
    }
}

#[cfg(test)]
impl NvColorApi for MockNvapi {
    fn supported(&self, _edid_id: &str) -> bool {
        self.supported
    }
    fn set(&self, _edid_id: &str, vibrance: f64, hue_deg: f64) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(("set".to_string(), vibrance, hue_deg));
        if self.fail_set {
            Err("mock vibrance failure".into())
        } else {
            Ok(())
        }
    }
    fn levels(&self, _edid_id: &str) -> Result<(f64, f64), String> {
        if self.fail_levels {
            Err("mock levels failure".into())
        } else {
            Ok(self.levels)
        }
    }
}

// --- Tests -----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- Mock tests ---------------------------------------------------

    #[test]
    fn mock_records_set_with_exact_values() {
        let mock = MockNvapi::new(true);
        mock.set(r".\DISPLAY5", 75.0, 120.0).unwrap();
        assert_eq!(
            *mock.calls.lock().unwrap(),
            vec![("set".to_string(), 75.0, 120.0)]
        );
    }

    #[test]
    fn mock_fail_set_returns_error() {
        let mut mock = MockNvapi::new(true);
        mock.fail_set = true;
        let err = mock.set(r".\DISPLAY5", 75.0, 0.0).unwrap_err();
        assert!(err.contains("mock vibrance failure"));
    }

    #[test]
    fn missing_dll_degrades_to_none() {
        assert!(load_nvapi("chromadeck_nonexistent_xyz.dll").is_none());
    }

    #[test]
    fn neutral_constants_match_spec() {
        assert_eq!(VIBRANCE_NEUTRAL, 50.0);
        assert_eq!(HUE_NEUTRAL, 0.0);
    }

    #[test]
    fn support_command_returns_false_for_unknown_edid() {
        // Unknown EDID -> device resolution fails -> false, no panic, no
        // driver contact beyond the (real, present) DLL load.
        assert!(!vibrance_supported_cmd("NO_SUCH_EDID".into()));
    }

    // --- load_nvapi edge cases ---------------------------------------

    #[test]
    fn dll_not_found_returns_none() {
        assert!(load_nvapi("does_not_exist_at_all.dll").is_none());
    }

    // --- Spec pins (hermetic) ---------------------------------------

    #[test]
    fn struct_versions_match_hardware_proven_values() {
        assert_eq!(nvapi_version::<DvcInfoEx>(), 0x10014);
        assert_eq!(nvapi_version::<HueInfo>(), 0x1000C);
    }

    #[test]
    fn resolve_unknown_edid_returns_none() {
        assert!(resolve_device_name("NO_SUCH_EDID").is_none());
    }
}
