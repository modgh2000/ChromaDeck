// — Identify Monitors: overlay windows showing monitor numbers —————————
// Windows-only. Creates a temporary overlay on each connected monitor.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use windows::Win32::Graphics::Gdi::{
    EnumDisplaySettingsW, ENUM_CURRENT_SETTINGS, DEVMODEW,
};
use windows::Win32::Foundation::{POINTL, RECT};
use tauri::Manager;
use crate::monitor::Monitor;

// — Pure helpers (testable) ————————————————————————————————

/// Format the overlay window label for monitor n (1-based).
/// The frontend routes any window whose label starts with `identify-`
/// to the IdentifyOverlay; keep this prefix stable.
pub fn identify_window_label(n: u32) -> String {
    format!("identify-{n}")
}

/// Physical-pixel bounds for a full-monitor overlay window.
///
/// The overlay covers its entire monitor, so it is positioned and sized in
/// physical pixels — never logical ones — which keeps it correct under any
/// DPI scale (100/125/150/200%) and for monitors with a negative origin
/// (ones placed left of / above the primary display).
///
/// Returns `(x, y, w, h)` with width and height clamped to at least 1 so a
/// degenerate or inverted `RECT` can never produce a zero-sized window.
pub fn overlay_bounds(r: &RECT) -> (i32, i32, u32, u32) {
    let w = (r.right - r.left).max(1) as u32;
    let h = (r.bottom - r.top).max(1) as u32;
    (r.left, r.top, w, h)
}

/// Query the current display settings for an exact Win32 device name
/// (e.g. `\\.\DISPLAY1`). Returns the DEVMODEW on success.
fn devmode_for_device(device_name: &str) -> Option<DEVMODEW> {
    let mut dm = DEVMODEW::default();
    dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    let wide: Vec<u16> = OsStr::new(device_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: wide is null-terminated and lives for the whole call.
    let ok = unsafe {
        EnumDisplaySettingsW(
            windows::core::PCWSTR::from_raw(wide.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut dm,
        )
    };
    if !ok.as_bool() {
        return None;
    }
    Some(dm)
}

/// Resolve a ChromaDeck device_name to its on-screen RECT by querying
/// that exact device. Returns None when the device has no current
/// settings (disconnected / mirrored away).
fn find_monitor_rect(device_name: &str) -> Option<RECT> {
    devmode_for_device(device_name).map(|dm| devmode_to_rect(&dm))
}

/// Convert a DEVMODEW's dmPosition / dmPelsWidth / dmPelsHeight to a RECT.
fn devmode_to_rect(dm: &DEVMODEW) -> RECT {
    let pos: POINTL = unsafe { dm.Anonymous1.Anonymous2.dmPosition };
    RECT {
        left: pos.x,
        top: pos.y,
        right: pos.x + dm.dmPelsWidth as i32,
        bottom: pos.y + dm.dmPelsHeight as i32,
    }
}

/// Display name for the identify overlay: user alias first, then model,
/// device name, EDID prefix. Mirrors the frontend fallback in
/// MonitorSidebar (`alias || model || device_name || edid slice`).
pub fn display_name(m: &Monitor) -> String {
    if !m.alias.is_empty() {
        return m.alias.clone();
    }
    if !m.model.is_empty() {
        return m.model.clone();
    }
    if !m.device_name.is_empty() {
        return m.device_name.clone();
    }
    m.edid_id.chars().take(16).collect()
}

/// Overlay payload for monitor `n`: display name + connected total.
#[derive(serde::Serialize)]
pub struct IdentifyInfo {
    pub name: String,
    pub total: u32,
}

/// Pure mapping from a monitor list to overlay info for 1-based `n`.
/// Returns None when `n` is out of range (including `n == 0`).
pub fn identify_info_for(monitors: &[Monitor], n: u32) -> Option<IdentifyInfo> {
    let connected: Vec<&Monitor> = monitors.iter().filter(|m| m.connected).collect();
    let total = connected.len() as u32;
    let m = connected.get(n.checked_sub(1)? as usize)?;
    Some(IdentifyInfo {
        name: display_name(m),
        total,
    })
}

/// Resolve overlay info for the 1-based monitor number `n` (same ordering
/// as `identify_monitors_cmd`). Overlay windows invoke this on mount to
/// show the monitor's display name. Aliases are merged from the store so
/// user-renamed monitors show their custom names.
#[tauri::command]
pub fn identify_info_cmd(
    state: tauri::State<'_, crate::store::AppStore>,
    n: u32,
) -> Result<IdentifyInfo, String> {
    let mut monitors = crate::monitor::list_monitors();
    if let Ok(store) = state.0.lock() {
        let names = store.list_monitor_names();
        for m in &mut monitors {
            if let Some(alias) = names.get(&m.edid_id) {
                m.alias = alias.clone();
            }
        }
    }
    identify_info_for(&monitors, n)
        .ok_or_else(|| format!("no connected monitor number {n}"))
}

// — Tauri command ————————————————————————————————

#[tauri::command]
pub async fn identify_monitors_cmd(
    app: tauri::AppHandle,
) -> Vec<u32> {
    let monitors = crate::monitor::list_monitors();
    let connected = monitors.into_iter().filter(|m| m.connected).collect::<Vec<_>>();
    let mut shown: Vec<u32> = Vec::new();
    let mut created: Vec<String> = Vec::new();

    for (i, m) in connected.iter().enumerate() {
        let n = (i + 1) as u32; // 1-based sidebar order
        let rect = find_monitor_rect(&m.device_name);
        if rect.is_none() {
            // unmatched - report and skip
            eprintln!(
                "identify: no Win32 monitor found for device {} ({})",
                m.device_name,
                m.edid_id,
            );
            continue;
        }
        let r = rect.unwrap();
        let (ox, oy, ow, oh) = overlay_bounds(&r);

        let label = identify_window_label(n);
        // SAFETY: WebviewWindowBuilder is called from an async command,
        // which avoids the Windows deadlock documented in Tauri.
        //
        // The window is built hidden, then positioned and sized in PHYSICAL
        // pixels. Position is applied before size: moving the window onto a
        // monitor with a different DPI triggers WM_DPICHANGED, and we want
        // that resize to happen before the final full-monitor size is set.
        let built = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .build();

        match built {
            Ok(win) => {
                if let Err(e) = win.set_position(tauri::PhysicalPosition::new(ox, oy)) {
                    eprintln!("identify: set_position failed for {label}: {e}");
                }
                if let Err(e) = win.set_size(tauri::PhysicalSize::new(ow, oh)) {
                    eprintln!("identify: set_size failed for {label}: {e}");
                }
                // Full-monitor overlay must not swallow the user's clicks
                // while it is up for ~4 s.
                if let Err(e) = win.set_ignore_cursor_events(true) {
                    eprintln!("identify: set_ignore_cursor_events failed for {label}: {e}");
                }
                if let Err(e) = win.show() {
                    eprintln!("identify: show failed for {label}: {e}");
                }
                shown.push(n);
                created.push(label);
            }
            Err(e) => {
                eprintln!(
                    "identify: failed to create overlay {label} for device {} ({}): {e}",
                    m.device_name,
                    m.edid_id,
                );
            }
        }
    }

    // Spawn a background task to destroy the overlay windows after ~4 s.
    let app_handle = app.clone();
    let labels = created.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        for lbl in labels {
            if let Some(ww) = app_handle.get_webview_window(&lbl) {
                let _ = ww.destroy();
            }
        }
    });

    shown
}

// — Tests ————————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    // — identify_window_label ————————————————————————

    #[test]
    fn label_format_matches_frontend_route() {
        // main.tsx routes labels starting with "identify-" to the overlay.
        assert_eq!(identify_window_label(1), "identify-1");
        assert_eq!(identify_window_label(3), "identify-3");
        assert!(!identify_window_label(2).starts_with("identify-"));
    }

    // — overlay_bounds ————————————————————————

    #[test]
    fn bounds_cover_normal_monitor_at_origin() {
        let r = RECT { left: 0, top: 0, right: 1920, bottom: 1080 };
        assert_eq!(overlay_bounds(&r), (0, 0, 1920, 1080));
    }

    #[test]
    fn bounds_cover_monitor_with_negative_origin() {
        // Secondary monitor to the left of the primary (e.g. -1920, 0).
        let r = RECT { left: -1920, top: 0, right: 0, bottom: 1080 };
        assert_eq!(overlay_bounds(&r), (-1920, 0, 1920, 1080));
        // ...and one above it.
        let r = RECT { left: 0, top: -2560, right: 1440, bottom: 0 };
        assert_eq!(overlay_bounds(&r), (0, -2560, 1440, 2560));
    }

    #[test]
    fn bounds_clamp_degenerate_rect_to_one_pixel() {
        let r = RECT { left: 100, top: 200, right: 100, bottom: 200 };
        assert_eq!(overlay_bounds(&r), (100, 200, 1, 1));
        // Inverted rect (right < left) must not underflow into a huge u32.
        let r = RECT { left: 100, top: 200, right: 50, bottom: 150 };
        assert_eq!(overlay_bounds(&r), (100, 200, 1, 1));
    }

    // — find_monitor_rect: exact-device query ——————————————————
    // NOTE: the previous implementation guessed `\\.\DISPLAY{index+1}`
    // names by adapter index (and built them with a malformed escape:
    // three backslashes before the dot). It failed on any machine with
    // a numbering gap (e.g. DISPLAY1 + DISPLAY5) and on every lookup.
    // find_monitor_rect now queries the exact device_name, so there is
    // no name to unit-test — only the rect math above is pure.

    // — display_name / identify_info_for ——————————————————————

    fn fake_monitor(alias: &str, model: &str, device: &str, connected: bool) -> Monitor {
        Monitor {
            edid_id: "ABCDEF1234567890EXTRA".into(),
            model: model.into(),
            serial: String::new(),
            connected,
            device_name: device.into(),
            alias: alias.into(),
        }
    }

    #[test]
    fn display_name_prefers_alias() {
        let m = fake_monitor("Office Left", "VG27A", "\\\\.\\DISPLAY1", true);
        assert_eq!(display_name(&m), "Office Left");
    }

    #[test]
    fn display_name_falls_back_to_model_then_device_then_edid() {
        let m = fake_monitor("", "VG27A", "\\\\.\\DISPLAY1", true);
        assert_eq!(display_name(&m), "VG27A");
        let m = fake_monitor("", "", "\\\\.\\DISPLAY1", true);
        assert_eq!(display_name(&m), "\\\\.\\DISPLAY1");
        let m = fake_monitor("", "", "", true);
        assert_eq!(display_name(&m), "ABCDEF1234567890");
    }

    #[test]
    fn identify_info_maps_one_based_connected_order() {
        let monitors = vec![
            fake_monitor("Left", "A", "D1", true),
            fake_monitor("", "", "", false), // disconnected: skipped
            fake_monitor("", "RightModel", "D3", true),
        ];
        let info = identify_info_for(&monitors, 1).unwrap();
        assert_eq!((info.name.as_str(), info.total), ("Left", 2));
        let info = identify_info_for(&monitors, 2).unwrap();
        assert_eq!((info.name.as_str(), info.total), ("RightModel", 2));
    }

    #[test]
    fn identify_info_rejects_out_of_range() {
        let monitors = vec![fake_monitor("Left", "A", "D1", true)];
        assert!(identify_info_for(&monitors, 0).is_none());
        assert!(identify_info_for(&monitors, 2).is_none());
        let empty: Vec<Monitor> = vec![];
        assert!(identify_info_for(&empty, 1).is_none());
    }
}
