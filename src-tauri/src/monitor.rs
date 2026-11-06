// --- EDID-based monitor enumeration via adapter-monitor tree walk ---------
// Windows-only. Each adapter's children are physical monitors with real names
// from EDID. Pure identify_monitor() resolves identity without Win32 calls.

use serde::Serialize;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::ffi::OsStringExt;
use winreg::enums::*;
use winreg::RegKey;
use winreg::types::FromRegValue;
use winreg::RegValue;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::*;

/// A monitor identified by its stable EDID serial / product string.
#[derive(Debug, Clone, Serialize)]
pub struct Monitor {
    pub edid_id: String,
    pub model: String,
    pub serial: String,
    pub connected: bool,
    pub device_name: String, // e.g. "\\.\DISPLAY1"
    pub alias: String,      // user display name; empty = use model
}

// --- EDID parsing -----------------------------------------------------------

/// Parse the serial-number string from a raw 128-byte EDID block.
///
/// EDID stores monitor descriptors (name, serial, etc.) in four 18-byte blocks
/// starting at offsets 0x36, 0x48, 0x5A and 0x6C. A descriptor with tag 0xFF
/// contains the serial as a 13-byte ASCII string (padded with spaces / 0x0A).
pub fn parse_edid_serial(edid: &[u8; 128]) -> Option<String> {
    for off in [0x36, 0x48, 0x5A, 0x6C] {
        // Monitor descriptors have 0x0000 in the first two bytes.
        if edid[off] != 0x00 || edid[off + 1] != 0x00 {
            continue;
        }
        if edid[off + 3] == 0xFF {
            // Bytes 4..17 carry the serial string.
            let raw = &edid[off + 4..off + 18];
            let s: String = raw
                .iter()
                .take_while(|&&b| b != 0x0A && b != 0x00)
                .map(|&b| b as char)
                .collect();
            let trimmed = s.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// Parse the monitor-name string from a raw 128-byte EDID block.
///
/// Descriptor tag 0xFC holds the monitor's name as a 13-byte ASCII string.
pub fn parse_edid_model_name(edid: &[u8; 128]) -> Option<String> {
    for off in [0x36, 0x48, 0x5A, 0x6C] {
        if edid[off] != 0x00 || edid[off + 1] != 0x00 {
            continue;
        }
        if edid[off + 3] == 0xFC {
            let raw = &edid[off + 4..off + 18];
            let s: String = raw
                .iter()
                .take_while(|&&b| b != 0x0A && b != 0x00)
                .map(|&b| b as char)
                .collect();
            let trimmed = s.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

// --- Monitor enumeration via adapter-monitor tree walk -----------------

/// Enumerate all connected monitors. Adapter-monitor tree walk: each
/// adapter's child entries are physical monitors with real names.
/// Adapters without children are skipped, so GPU rows never appear.
pub fn list_monitors() -> Vec<Monitor> {
    enum_gdi_monitors()
}

fn enum_gdi_monitors() -> Vec<Monitor> {
    let mut monitors = Vec::new();
    for adapter_index in 0.. {
        let mut adapter = DISPLAY_DEVICEW::default();
        adapter.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        // SAFETY: EnumDisplayDevicesW with NULL enumerates adapters.
        let ok = unsafe { EnumDisplayDevicesW(None, adapter_index, &mut adapter, 0) };
        if !ok.as_bool() {
            break;
        }
        let adapter_name = wide_to_string(&adapter.DeviceName);
        if adapter_name.is_empty() {
            continue;
        }
        // Ruling (plan refines spec §1 wording): attachment is an
        // adapter-output property, so the adapter flag alone governs
        // `connected`. Child entries do not reliably carry
        // ATTACHED_TO_DESKTOP (commonly 0); requiring it would misreport
        // live monitors as disconnected.
        let adapter_attached = (adapter.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)
            == DISPLAY_DEVICE_ATTACHED_TO_DESKTOP;
        let wide_adapter: Vec<u16> = OsStr::new(&adapter_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut child_index = 0;
        loop {
            let mut child = DISPLAY_DEVICEW::default();
            child.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            // SAFETY: child enumeration for a valid adapter name string.
            let ok = unsafe {
                EnumDisplayDevicesW(
                    PCWSTR::from_raw(wide_adapter.as_ptr()),
                    child_index,
                    &mut child,
                    0,
                )
            };
            if !ok.as_bool() {
                break;
            }
            child_index += 1;
            let instance_id = wide_to_string(&child.DeviceID);
            if instance_id.is_empty() {
                continue;
            }
            let device_string = wide_to_string(&child.DeviceString);
            let edid: Option<[u8; 128]> = read_edid_for_monitor(&instance_id)
                .and_then(base_block);
            let (edid_id, model, serial) =
                identify_monitor(edid.as_ref(), &instance_id, &device_string);
            monitors.push(Monitor {
                edid_id,
                model,
                serial,
                connected: adapter_attached,
                device_name: adapter_name.clone(),
                alias: String::new(),
            });
        }
    }
    monitors
}

// --- Helper: wide-char array to String ---------------------------------------

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..len])
        .to_string_lossy()
        .to_string()
}

// --- Pure monitor identity resolver -----------------------------------------

/// Manufacturer 3-letter code from EDID bytes 8-9 (big-endian 5-bit packed,
/// A=1). Used for constructed display names on nameless panels.
fn parse_edid_manufacturer(edid: &[u8; 128]) -> String {
    let raw = u16::from_be_bytes([edid[8], edid[9]]);
    [(raw >> 10) & 0x1F, (raw >> 5) & 0x1F, raw & 0x1F]
        .iter()
        .map(|&c| (b'A' + c as u8 - 1) as char)
        .collect()
}

/// Best display name when the EDID name descriptor is absent: a constructed
/// `MFR PRODUCT` tag (laptop panels typically carry no name). `None` when
/// the EDID carries no manufacturer (blank block).
fn constructed_model(ed: &[u8; 128]) -> Option<String> {
    if ed[8] == 0 && ed[9] == 0 {
        return None;
    }
    Some(format!(
        "{} {:04X}",
        parse_edid_manufacturer(ed),
        u16::from_le_bytes([ed[10], ed[11]])
    ))
}

/// Resolve stable identity + display name from EDID (when available),
/// instance path, and GDI device string. Pure function - fully testable.
///
/// Chain: EDID serial -> manufacturer+product+numeric serial -> instance path.
/// Name chain: EDID name -> constructed MFR+product -> device string ->
/// instance path.
fn identify_monitor(
    edid: Option<&[u8; 128]>,
    instance_id: &str,
    device_string: &str,
) -> (String, String, String) {
    if let Some(ed) = edid {
        let serial = parse_edid_serial(ed).unwrap_or_default();
        let mut model = parse_edid_model_name(ed).unwrap_or_default();
        if model.is_empty() {
            model = constructed_model(ed).unwrap_or_default();
        }
        if model.is_empty() {
            model = device_string.to_string();
        }
        if !serial.is_empty() {
            return (serial.clone(), model, serial);
        }
        let mfr = u16::from_be_bytes([ed[8], ed[9]]);
        let prod = u16::from_le_bytes([ed[10], ed[11]]);
        let ser = u32::from_le_bytes([ed[12], ed[13], ed[14], ed[15]]);
        let unit = format!("EDID:{mfr:04X}-{prod:04X}-{ser:08X}");
        return (unit, model, String::new());
    }
    let model = if device_string.is_empty() {
        instance_id.to_string()
    } else {
        device_string.to_string()
    };
    (instance_id.to_string(), model, String::new())
}

/// Derive ChromaDeck's stable `edid_id` from a raw 128-byte EDID block, using
/// the exact same chain as `identify_monitor`: EDID serial string if present,
/// else `EDID:{mfr:04X}-{prod:04X}-{ser:08X}`. Shared by the Intel backend so
/// its IGCL EDID read produces device-identical keys to `list_monitors`.
pub(crate) fn edid_id_from_bytes(ed: &[u8; 128]) -> String {
    if let Some(serial) = parse_edid_serial(ed) {
        return serial;
    }
    let mfr = u16::from_be_bytes([ed[8], ed[9]]);
    let prod = u16::from_le_bytes([ed[10], ed[11]]);
    let ser = u32::from_le_bytes([ed[12], ed[13], ed[14], ed[15]]);
    format!("EDID:{mfr:04X}-{prod:04X}-{ser:08X}")
}

// --- EDID registry reader --------------------------------------------------
struct EdidBlob(Vec<u8>);

impl FromRegValue for EdidBlob {
    fn from_reg_value(val: &RegValue) -> io::Result<Self> {
        Ok(EdidBlob(val.bytes.clone()))
    }
}

/// Read the EDID blob for a monitor DeviceID (`MONITOR\<model>\...`).
/// Resolves via `Enum\DISPLAY\<model>`, subkeys sorted for determinism,
/// first blob >=128 bytes wins. Identical-twin panels are an accepted
/// limitation: either twin's EDID may attach (documented).
fn read_edid_for_monitor(device_id: &str) -> Option<Vec<u8>> {
    let model = device_id.split('\\').nth(1)?;
    let base = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            format!(r"SYSTEM\CurrentControlSet\Enum\DISPLAY\{model}"),
            KEY_READ,
        )
        .ok()?;
    let mut names: Vec<String> = base.enum_keys().filter_map(|k| k.ok()).collect();
    names.sort();
    for name in names {
        let params = base
            .open_subkey_with_flags(format!("{name}\\Device Parameters"), KEY_READ)
            .ok()?;
        let blob: EdidBlob = params.get_value("EDID").ok()?;
        if blob.0.len() >= 128 {
            return Some(blob.0);
        }
    }
    None
}

/// Take the base 128-byte EDID block from a registry blob.
///
/// Hardware root cause, second half (2026-09-30): real blobs are usually
/// 256 bytes (base + extension); a direct `try_into()` to `[u8; 128]`
/// rejects them by length, silently dropping EDIDs that parsed fine.
/// The base block (bytes 0-127) is what every parser consumes.
fn base_block(blob: Vec<u8>) -> Option<[u8; 128]> {
    let arr: &[u8; 128] = blob.get(..128)?.try_into().ok()?;
    Some(*arr)
}

// --- Tauri command -----------------------------------------------------------

#[tauri::command]
pub fn list_monitors_cmd(state: tauri::State<'_, crate::store::AppStore>) -> Vec<Monitor> {
    let mut monitors = list_monitors();
    if let Ok(store) = state.0.lock() {
        let names = store.list_monitor_names();
        for m in &mut monitors {
            if let Some(alias) = names.get(&m.edid_id) {
                m.alias = alias.clone();
            }
        }
    }
    monitors
}

// --- Tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal 128-byte EDID with a serial-number descriptor at
    /// offset 0x48 (block 2). Everything else is zeroed.
    fn fake_edid_blob(serial: &str) -> Box<[u8; 128]> {
        let mut buf = Box::new([0u8; 128]);
        // EDID header (magic)
        buf[0..8]
            .copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);

        // Place a serial descriptor at offset 0x48 (18-byte block 2).
        let off = 0x48;
        buf[off] = 0x00; // word low
        buf[off + 1] = 0x00; // word high -> monitor descriptor
        buf[off + 2] = 0x00; // reserved
        buf[off + 3] = 0xFF; // serial tag

        // Copy the string into bytes 4..17, pad with 0x0A.
        let raw = serial.as_bytes();
        let n = raw.len().min(13);
        buf[off + 4..off + 4 + n].copy_from_slice(&raw[..n]);
        if n < 13 {
            buf[off + 4 + n] = 0x0A; // terminate
        }
        buf
    }

    /// Builds a minimal EDID with a monitor-name descriptor at offset 0x36.
    fn fake_edid_blob_with_model(name: &str) -> Box<[u8; 128]> {
        let mut buf = Box::new([0u8; 128]);
        buf[0..8]
            .copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);

        let off = 0x36;
        buf[off] = 0x00;
        buf[off + 1] = 0x00;
        buf[off + 2] = 0x00;
        buf[off + 3] = 0xFC; // monitor name tag

        let raw = name.as_bytes();
        let n = raw.len().min(13);
        buf[off + 4..off + 4 + n].copy_from_slice(&raw[..n]);
        if n < 13 {
            buf[off + 4 + n] = 0x0A;
        }
        buf
    }

    // --- parse_edid_serial ---------------------------------------------------

    #[test]
    fn parses_edid_serial() {
        let edid = fake_edid_blob("ABC123");
        let got = parse_edid_serial(&edid).expect("should find serial");
        assert_eq!(got, "ABC123");
    }

    #[test]
    fn returns_none_for_edid_without_serial() {
        let edid = fake_edid_blob_with_model("Test Monitor");
        let got = parse_edid_serial(&edid);
        assert!(got.is_none(), "no serial descriptor present");
    }

    #[test]
    fn handles_empty_serial_descriptor() {
        let mut buf = Box::new([0u8; 128]);
        buf[0..8]
            .copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);

        let off = 0x36;
        buf[off] = 0x00;
        buf[off + 1] = 0x00;
        buf[off + 2] = 0x00;
        buf[off + 3] = 0xFF;
        buf[off + 4] = 0x0A; // empty string

        let edid: &[u8; 128] = &*buf;
        let got = parse_edid_serial(edid);
        assert!(got.is_none(), "empty serial yields None");
    }

    #[test]
    fn serial_stops_at_newline() {
        let buf = fake_edid_blob("ABC123");
        let got = parse_edid_serial(&buf).expect("should find serial");
        assert_eq!(got, "ABC123", "trailing 0x0A should be stripped");
    }

    // --- parse_edid_model_name -----------------------------------------------

    #[test]
    fn parses_edid_model_name() {
        let edid = fake_edid_blob_with_model("DELL U2719D");
        let got = parse_edid_model_name(&edid).expect("should find model name");
        assert_eq!(got, "DELL U2719D");
    }

    #[test]
    fn returns_none_for_edid_without_model_name() {
        let edid = fake_edid_blob("serial123");
        let got = parse_edid_model_name(&edid);
        assert!(got.is_none(), "no model name descriptor present");
    }

    #[test]
    fn model_name_stops_at_newline() {
        let edid = fake_edid_blob_with_model("Samsung S24");
        let got = parse_edid_model_name(&edid).expect("should find model name");
        assert_eq!(got, "Samsung S24");
    }

    // --- identify_monitor --------------------------------------------------

    #[test]
    fn identify_prefers_serial_and_edid_name() {
        let mut buf = fake_edid_blob("ABC123");
        buf[0x36] = 0x00;
        buf[0x36 + 1] = 0x00;
        buf[0x36 + 2] = 0x00;
        buf[0x36 + 3] = 0xFC;
        buf[0x36 + 4..0x36 + 4 + 7].copy_from_slice(b"MyPanel");
        buf[0x36 + 4 + 7] = 0x0A;
        let (id, model, serial) =
            identify_monitor(Some(&*buf), "MONITOR\\X\\0", "GDI Name");
        assert_eq!(id, "ABC123");
        assert_eq!(model, "MyPanel");
        assert_eq!(serial, "ABC123");
    }

    #[test]
    fn identify_falls_back_to_unit_id_without_serial() {
        let mut buf = Box::new([0u8; 128]);
        buf[0..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        buf[8] = 0x04;
        buf[9] = 0x41; // mfr 0x0441 -> "ABA"
        buf[10] = 0x34;
        buf[11] = 0x12; // product LE 0x1234
        buf[12] = 0x78;
        buf[13] = 0x56;
        buf[14] = 0x34;
        buf[15] = 0x12; // serial LE 0x12345678
        let (id, model, serial) =
            identify_monitor(Some(&*buf), "MONITOR\\X\\0", "GDI Name");
        assert_eq!(id, "EDID:0441-1234-12345678");
        assert_eq!(model, "ABA 1234");
        assert_eq!(serial, "");
    }

    #[test]
    fn identify_without_edid_uses_instance_path() {
        let (id, model, serial) =
            identify_monitor(None, "MONITOR\\FOO\\1&2&3", "Generic Monitor");
        assert_eq!(id, "MONITOR\\FOO\\1&2&3");
        assert_eq!(model, "Generic Monitor");
        assert_eq!(serial, "");
    }

    #[test]
    fn identify_empty_device_string_falls_back_to_instance() {
        let (id, model, _) = identify_monitor(None, "MONITOR\\FOO\\1", "");
        assert_eq!(id, "MONITOR\\FOO\\1");
        assert_eq!(model, "MONITOR\\FOO\\1");
    }

    #[test]
    fn manufacturer_decodes_three_letters() {
        let mut buf = Box::new([0u8; 128]);
        buf[8] = 0x04;
        buf[9] = 0x43; // 0x0443 -> A=1, B=2, C=3
        assert_eq!(parse_edid_manufacturer(&buf), "ABC");
    }

    #[test]
    fn identify_constructs_name_without_descriptor() {
        let mut buf = Box::new([0u8; 128]);
        buf[0..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        buf[8] = 0x04;
        buf[9] = 0x43;
        buf[10] = 0x34;
        buf[11] = 0x12; // product 0x1234
        let (id, model, serial) = identify_monitor(Some(&*buf), "MONITOR\\X\\0", "GDI Name");
        assert_eq!(id, "EDID:0443-1234-00000000");
        assert_eq!(model, "ABC 1234");
        assert_eq!(serial, "");
    }

    #[test]
    fn edid_id_from_bytes_matches_identify_monitor_unit_id() {
        // Mirrors the internal AUO panel (mfr 0x06AF, prod 0xF7AD, ser 0).
        let mut buf = Box::new([0u8; 128]);
        buf[0..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        buf[8] = 0x06;
        buf[9] = 0xAF;
        buf[10] = 0xAD;
        buf[11] = 0xF7; // product LE 0xF7AD
        assert_eq!(edid_id_from_bytes(&buf), "EDID:06AF-F7AD-00000000");
        // And the same bytes through identify_monitor must agree.
        let (id, _, _) = identify_monitor(Some(&*buf), "MONITOR\\X\\0", "GDI Name");
        assert_eq!(id, edid_id_from_bytes(&buf));
    }

    #[test]
    fn base_block_accepts_256_byte_blob() {
        // Base block carries a serial descriptor; extension half is zeros.
        let mut blob = vec![0u8; 256];
        blob[0..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        let off = 0x48;
        blob[off] = 0x00;
        blob[off + 1] = 0x00;
        blob[off + 2] = 0x00;
        blob[off + 3] = 0xFF;
        blob[off + 4..off + 4 + 6].copy_from_slice(b"ABC123");
        blob[off + 4 + 6] = 0x0A;
        let base = base_block(blob).expect("first 128 bytes must parse");
        assert_eq!(parse_edid_serial(&base).as_deref(), Some("ABC123"));
    }
}
