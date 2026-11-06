// — Per-adjustment capability resolver ————————————————————————————————
// Phase C of the universal-display plan. Maps the backend selected for a
// display (`backend::BackendRegistry`) to a per-adjustment verdict table for
// the unified preset editor.
//
// Tables are pure functions of (backend id, live vibrance probe) so they stay
// hermetic in tests. The only driver contact happens in the Tauri command,
// which feeds the existing NVAPI DVC probe into `capabilities_for_backend`
// and, for Intel, runs the live IGCL pixtx/HDR/correlation probe.

use serde::Serialize;

use crate::backend::{
    AdjustmentCap, AdjustmentCapability, BackendRegistry, ColorBackend, GdiBackend, IntelBackend,
    NvapiBackend, ADJUSTMENT_BRIGHTNESS, ADJUSTMENT_CONTRAST, ADJUSTMENT_GAMMA, ADJUSTMENT_HUE,
    ADJUSTMENT_RGB_GAINS, ADJUSTMENT_SATURATION, ADJUSTMENT_VIBRANCE,
};
use crate::nvapi::{NvColorApi, RealNvapi};

// — Wire types ————————————————————————————————

/// Verdict for one adjustment, serialized lowercase to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityStatus {
    Supported,
    Approximate,
    Unsupported,
}

/// One adjustment's capability verdict. `reason` carries the human-readable
/// explanation for Unsupported and the mapping note for Approximate; it is
/// absent for Supported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DisplayCapability {
    pub adjustment: &'static str,
    pub status: CapabilityStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// Full capability report for one display: which backend will apply the
/// preset and how each adjustment is delivered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DisplayCapabilities {
    pub backend_id: String,
    pub backend_label: String,
    pub adjustments: Vec<DisplayCapability>,
}

// — Resolver ————————————————————————————————

/// Resolve the capability report for a backend id.
///
/// `vibrance_supported` is the live NVAPI DVC probe result for the display;
/// it is only consulted by the "nvapi" arm. Passing `false` for a display
/// whose DVC probe cannot run correctly reports vibrance/hue Unsupported.
pub fn capabilities_for_backend(
    backend_id: &str,
    vibrance_supported: bool,
) -> DisplayCapabilities {
    let (backend_label, table) = match backend_id {
        "nvapi" => ("NVIDIA (NVAPI)", nvapi_table(vibrance_supported)),
        "gdi" => ("Basic (GDI)", gdi_table()),
        // Nominal Intel table (healthy panel); the live HDR/pixtx probe
        // refines it in `get_display_capabilities`.
        "intel" => ("Intel (IGCL)", intel_table()),
        _ => ("Unknown backend", unknown_backend_table()),
    };

    DisplayCapabilities {
        backend_id: backend_id.to_string(),
        backend_label: backend_label.to_string(),
        adjustments: table.into_iter().map(to_wire).collect(),
    }
}

/// NVIDIA: gamma family + vibrance/hue are native; desktop saturation is not
/// an NVAPI control. Vibrance/hue honour the live DVC probe.
fn nvapi_table(vibrance_supported: bool) -> Vec<AdjustmentCapability> {
    NvapiBackend
        .probe("")
        .into_iter()
        .map(|mut c| {
            if !vibrance_supported
                && matches!(c.adjustment, ADJUSTMENT_VIBRANCE | ADJUSTMENT_HUE)
            {
                c.cap = AdjustmentCap::Unsupported(
                    "NVAPI reports no vibrance/hue control for this display",
                );
            }
            c
        })
        .collect()
}

/// GDI fallback: gamma-family only.
fn gdi_table() -> Vec<AdjustmentCapability> {
    GdiBackend.probe("")
}

/// Intel IGCL: gamma/brightness/contrast via the pixtx 1D LUT, rgb_gains/
/// saturation/hue via the pixtx 3x3 matrix; vibrance has no IGCL analogue.
/// This is the *nominal* table (a healthy Intel panel). The live
/// HDR/pixtx/correlation probe in `get_display_capabilities` refines it.
fn intel_table() -> Vec<AdjustmentCapability> {
    IntelBackend::nominal_probe()
}

/// Defensive fallback for an unrecognised backend id: claim nothing.
fn unknown_backend_table() -> Vec<AdjustmentCapability> {
    const REASON: &str = "unknown colour backend";
    adjustment_names()
        .into_iter()
        .map(|adjustment| AdjustmentCapability {
            adjustment,
            cap: AdjustmentCap::Unsupported(REASON),
        })
        .collect()
}

fn adjustment_names() -> [&'static str; 7] {
    [
        ADJUSTMENT_GAMMA,
        ADJUSTMENT_BRIGHTNESS,
        ADJUSTMENT_CONTRAST,
        ADJUSTMENT_RGB_GAINS,
        ADJUSTMENT_SATURATION,
        ADJUSTMENT_VIBRANCE,
        ADJUSTMENT_HUE,
    ]
}

fn to_wire(c: AdjustmentCapability) -> DisplayCapability {
    let (status, reason) = match c.cap {
        AdjustmentCap::Supported => (CapabilityStatus::Supported, None),
        AdjustmentCap::Unsupported(reason) => (CapabilityStatus::Unsupported, Some(reason)),
        AdjustmentCap::Approximate(note) => (CapabilityStatus::Approximate, Some(note)),
    };
    DisplayCapability {
        adjustment: c.adjustment,
        status,
        reason,
    }
}

// — Tauri command ————————————————————————————————

/// Report per-adjustment capabilities for a display. Backend selection mirrors
/// `apply_preset`, so the editor shows what will actually be attempted.
#[tauri::command]
pub fn get_display_capabilities(edid_id: String) -> DisplayCapabilities {
    let registry = BackendRegistry::new();
    let backend = registry.select(&edid_id);
    let id = backend.id();
    if id == "intel" {
        // Live Intel probe: correlation + pixtx capability + HDR verdicts.
        return DisplayCapabilities {
            backend_id: id.to_string(),
            backend_label: "Intel (IGCL)".to_string(),
            adjustments: backend.probe(&edid_id).into_iter().map(to_wire).collect(),
        };
    }
    let vibrance_supported = id == "nvapi" && RealNvapi.supported(&edid_id);
    capabilities_for_backend(id, vibrance_supported)
}

// — Tests ————————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;

    fn cap<'a>(caps: &'a DisplayCapabilities, name: &str) -> &'a DisplayCapability {
        caps.adjustments
            .iter()
            .find(|c| c.adjustment == name)
            .unwrap_or_else(|| panic!("missing capability entry for {name}"))
    }

    // — NVIDIA ————————————————————————————————

    #[test]
    fn nvapi_reports_gamma_family_and_vibrance_supported() {
        let caps = capabilities_for_backend("nvapi", true);
        assert_eq!(caps.backend_id, "nvapi");
        assert_eq!(caps.backend_label, "NVIDIA (NVAPI)");
        for name in [
            ADJUSTMENT_GAMMA,
            ADJUSTMENT_BRIGHTNESS,
            ADJUSTMENT_CONTRAST,
            ADJUSTMENT_RGB_GAINS,
            ADJUSTMENT_VIBRANCE,
            ADJUSTMENT_HUE,
        ] {
            assert_eq!(cap(&caps, name).status, CapabilityStatus::Supported, "{name}");
        }
    }

    #[test]
    fn nvapi_never_reports_saturation_supported() {
        for supported in [true, false] {
            let caps = capabilities_for_backend("nvapi", supported);
            let saturation = cap(&caps, ADJUSTMENT_SATURATION);
            assert_eq!(saturation.status, CapabilityStatus::Unsupported);
            assert!(saturation
                .reason
                .unwrap_or_default()
                .to_lowercase()
                .contains("saturation"));
        }
    }

    #[test]
    fn nvapi_live_probe_failure_disables_vibrance_and_hue() {
        let caps = capabilities_for_backend("nvapi", false);
        for name in [ADJUSTMENT_VIBRANCE, ADJUSTMENT_HUE] {
            let c = cap(&caps, name);
            assert_eq!(c.status, CapabilityStatus::Unsupported, "{name}");
            assert!(c.reason.is_some(), "{name} must carry a reason");
        }
        // Live probe failure must not downgrade the gamma family.
        assert_eq!(
            cap(&caps, ADJUSTMENT_GAMMA).status,
            CapabilityStatus::Supported
        );
    }

    // — GDI ————————————————————————————————

    #[test]
    fn gdi_supports_only_the_gamma_family() {
        let caps = capabilities_for_backend("gdi", false);
        assert_eq!(caps.backend_id, "gdi");
        assert_eq!(caps.backend_label, "Basic (GDI)");
        for name in [
            ADJUSTMENT_GAMMA,
            ADJUSTMENT_BRIGHTNESS,
            ADJUSTMENT_CONTRAST,
            ADJUSTMENT_RGB_GAINS,
        ] {
            assert_eq!(cap(&caps, name).status, CapabilityStatus::Supported, "{name}");
        }
        for name in [ADJUSTMENT_SATURATION, ADJUSTMENT_VIBRANCE, ADJUSTMENT_HUE] {
            let c = cap(&caps, name);
            assert_eq!(c.status, CapabilityStatus::Unsupported, "{name}");
            assert!(c.reason.is_some(), "{name} must carry a reason");
        }
    }

    // — Intel ————————————————————————————————

    #[test]
    fn intel_reports_real_verdicts() {
        let caps = capabilities_for_backend("intel", true);
        assert_eq!(caps.backend_id, "intel");
        assert_eq!(caps.backend_label, "Intel (IGCL)");
        assert_eq!(caps.adjustments.len(), 7);
        for name in [
            ADJUSTMENT_GAMMA,
            ADJUSTMENT_BRIGHTNESS,
            ADJUSTMENT_CONTRAST,
            ADJUSTMENT_RGB_GAINS,
            ADJUSTMENT_SATURATION,
            ADJUSTMENT_HUE,
        ] {
            assert_eq!(cap(&caps, name).status, CapabilityStatus::Supported, "{name}");
        }
        let vib = cap(&caps, ADJUSTMENT_VIBRANCE);
        assert_eq!(vib.status, CapabilityStatus::Unsupported);
        assert!(
            vib.reason.unwrap_or_default().contains("vibrance"),
            "vibrance reason must mention vibrance"
        );
    }

    // — Unknown backend ————————————————————————————————

    #[test]
    fn unknown_backend_claims_no_support() {
        let caps = capabilities_for_backend("amd-placeholder", true);
        assert_eq!(caps.adjustments.len(), 7);
        for c in &caps.adjustments {
            assert_eq!(c.status, CapabilityStatus::Unsupported);
            assert_eq!(c.reason, Some("unknown colour backend"));
        }
    }

    // — Wire shape ————————————————————————————————

    #[test]
    fn wire_shape_uses_lowercase_status_and_omits_supported_reason() {
        let caps = capabilities_for_backend("nvapi", true);
        let json = serde_json::to_value(&caps).unwrap();
        assert_eq!(json["backend_id"], "nvapi");
        assert_eq!(json["backend_label"], "NVIDIA (NVAPI)");
        let gamma = &json["adjustments"][0];
        assert_eq!(gamma["adjustment"], ADJUSTMENT_GAMMA);
        assert_eq!(gamma["status"], "supported");
        assert!(gamma.get("reason").is_none(), "Supported has no reason");

        let saturation = &json["adjustments"][4];
        assert_eq!(saturation["adjustment"], ADJUSTMENT_SATURATION);
        assert_eq!(saturation["status"], "unsupported");
        assert!(saturation.get("reason").is_some());
    }

    #[test]
    fn every_backend_reports_all_seven_adjustments_once() {
        for id in ["nvapi", "gdi", "intel", "unknown"] {
            let caps = capabilities_for_backend(id, true);
            assert_eq!(caps.adjustments.len(), 7, "{id}");
            for name in adjustment_names() {
                cap(&caps, name);
            }
        }
    }
}
