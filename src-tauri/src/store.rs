// — JSON preset store + bundled ICC file management ————————————————
// Windows-only.  Persists presets as presets.json under %APPDATA%/ChromaDeck
// and ICC profiles as profiles/{sha256}.icc, keyed by edid_id.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

fn default_vibrance() -> f64 { 50.0 }
fn default_saturation() -> f64 { 50.0 }
fn default_hue() -> f64 { 0.0 }
fn legacy_model() -> String { "gain-v1".into() }

/// Validate a color_tag value: must be empty or #rrggbb hex.
fn is_valid_color_tag(tag: &str) -> bool {
    if tag.is_empty() {
        return true;
    }
    if tag.len() != 7 || !tag.starts_with("#") {
        return false;
    }
    for c in tag[1..].chars() {
        if !matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F') {
            return false;
        }
    }
    true
}

/// Tag marker shapes accepted by the store. An empty value means "pill".
const TAG_SHAPES: [&str; 8] = [
    "pill",
    "round",
    "square",
    "bar",
    "diamond",
    "hexagon",
    "triangle",
    "ring",
];

/// Validate a tag_shape value: must be empty or one of TAG_SHAPES.
fn is_valid_tag_shape(shape: &str) -> bool {
    shape.is_empty() || TAG_SHAPES.contains(&shape)
}

/// Normalise an optional tag_shape: empty and "pill" are the default and
/// collapse to None so old and new files stay equivalent.
fn normalise_tag_shape(shape: Option<String>) -> Option<String> {
    match shape {
        Some(s) if s.is_empty() || s == "pill" => None,
        other => other,
    }
}

/// Produce a local-date timestamp string `yyyymmdd-HHMMSS` from SystemTime.
fn local_timestamp() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("SystemTime went backwards");
    let total_secs = dur.as_secs();
    let days = total_secs / 86400;
    let secs_today = total_secs % 86400;
    let h = secs_today / 3600;
    let m = (secs_today % 3600) / 60;
    let s = secs_today % 60;

    let mut y = 1970i64;
    let mut rem = days as i64;
    loop {
        let diy = if is_leap(y) { 366 } else { 365 };
        if rem < diy {
            break;
        }
        rem -= diy;
        y += 1;
    }
    let mon_lengths = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 1u32;
    for &ml in &mon_lengths {
        if rem < ml as i64 {
            break;
        }
        rem -= ml as i64;
        mo += 1;
    }
    let d = rem + 1;
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}")
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// — Types ——————————————————————————————————————————————————————————

/// A saved colour preset (global, not tied to one monitor).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub icc_hash: String,
    pub icc_filename: String,
    pub brightness: f64,
    pub contrast: f64,
    pub rgb_gains: [f64; 3],
    pub gamma: f64,
    #[serde(default = "default_vibrance")]
    pub vibrance: f64, // 0-100, 50 = neutral
    #[serde(default = "default_saturation")]
    pub saturation: f64, // 0-100, 50 = neutral (legacy JSON migrates to 50)
    #[serde(default = "default_hue")]
    pub hue_deg: f64, // 0-359 degrees
    #[serde(default = "legacy_model")]
    pub color_model: String,
    #[serde(default)]
    pub color_tag: Option<String>, // #rrggbb or None for untagged
    #[serde(default)]
    pub tag_shape: Option<String>, // pill | round | square | bar; None = pill
}

/// Input data for creating or updating a preset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetInput {
    pub name: String,
    pub icc_path: Option<String>,
    pub brightness: f64,
    pub contrast: f64,
    pub rgb_gains: [f64; 3],
    pub gamma: f64,
    pub vibrance: f64,
    #[serde(default = "default_saturation")]
    pub saturation: f64, // 0-100, 50 = neutral
    pub hue_deg: f64,
    #[serde(default)]
    pub color_tag: Option<String>,
    #[serde(default)]
    pub tag_shape: Option<String>,
}

// — Store errors ——————————————————————————————————————————————————

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Json(serde_json::Error),
    NotFound(String),
    InvalidInput(String),
    /// The store opened degraded because a data file could not be parsed.
    /// The file was backed up and every write is refused until it is
    /// restored or removed, so an unreadable library is never replaced.
    LoadFault(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "I/O error: {e}"),
            StoreError::Json(e) => write!(f, "JSON error: {e}"),
            StoreError::NotFound(id) => write!(f, "preset not found: {id}"),
            StoreError::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
            StoreError::LoadFault(msg) => write!(f, "write refused: {msg}"),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

// — Store ——————————————————————————————————————————————————————————

/// A preset as previously seeded on first run: exactly "Standard" with
/// untouched neutral values (no ICC). Only such a pristine preset is
/// removed by the standard-seed purge below – a user-tweaked or
/// user-created "Standard" keeps its pins and applied records.
fn is_neutral_standard(p: &Preset) -> bool {
    p.name == "Standard"
        && p.brightness == 50.0
        && p.contrast == 50.0
        && p.gamma == 1.0
        && p.rgb_gains == [1.0, 1.0, 1.0]
        && p.vibrance == 50.0
        && p.saturation == 50.0
        && p.hue_deg == 0.0
        && p.icc_hash.is_empty()
}

/// Files that failed to parse at load time. Non-empty means the store is
/// read-only: an unreadable file must never be replaced by a later flush.
#[derive(Debug, Default)]
struct LoadFaults {
    messages: Vec<String>,
}

impl LoadFaults {
    fn any(&self) -> bool {
        !self.messages.is_empty()
    }

    fn message(&self) -> Option<&str> {
        self.messages.first().map(String::as_str)
    }
}

/// Read and parse a JSON file. A missing file is `Ok(None)`. A file that
/// exists but cannot be parsed is copied to `<name>.bak-<timestamp>-corrupt`
/// and recorded in `faults`; the caller gets `None` so the app can still
/// open, but `Store` refuses all writes so the bad file is never overwritten.
fn read_json_or_backup<T: DeserializeOwned>(
    path: &Path,
    data_dir: &Path,
    faults: &mut LoadFaults,
) -> Option<T> {
    if !path.exists() {
        return None;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            faults.messages.push(format!(
                "Failed to read {}: {e}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            return None;
        }
    };
    match serde_json::from_str(&content) {
        Ok(v) => Some(v),
        Err(e) => {
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let bak_name = format!("{filename}.bak-{}-corrupt", local_timestamp());
            let bak_path = data_dir.join(&bak_name);
            let _ = std::fs::copy(path, &bak_path);
            faults.messages.push(format!(
                "File {filename} is corrupt ({e}). Backed up to {bak_name}. Saves disabled until file is restored or removed."
            ));
            None
        }
    }
}

pub struct Store {
    data_dir: PathBuf,
    profiles_dir: PathBuf,
    presets_path: PathBuf,
    pins_path: PathBuf,
    applied_path: PathBuf,
    names_path: PathBuf,
    presets: Vec<Preset>,
    pinned: HashMap<String, String>,            // edid_id -> preset_id
    applied: HashMap<String, String>,           // edid_id -> preset_id
    monitor_names: HashMap<String, String>,     // edid_id -> custom user-defined display name
    faults: LoadFaults,
}

impl Store {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, StoreError> {
        let profiles_dir = app_data_dir.join("profiles");
        std::fs::create_dir_all(&profiles_dir)?;

        let data_dir = app_data_dir.clone();
        let presets_path = data_dir.join("presets.json");
        let pins_path = data_dir.join("pins.json");
        let applied_path = data_dir.join("applied.json");
        let names_path = data_dir.join("names.json");

        let mut faults = LoadFaults::default();

        let presets: Vec<Preset> =
            read_json_or_backup(&presets_path, &data_dir, &mut faults).unwrap_or_default();
        let pinned: HashMap<String, String> =
            read_json_or_backup(&pins_path, &data_dir, &mut faults).unwrap_or_default();
        let applied: HashMap<String, String> =
            read_json_or_backup(&applied_path, &data_dir, &mut faults).unwrap_or_default();
        let monitor_names: HashMap<String, String> =
            read_json_or_backup(&names_path, &data_dir, &mut faults).unwrap_or_default();

        let mut store = Self {
            data_dir,
            profiles_dir,
            presets_path,
            presets,
            pins_path,
            pinned,
            applied_path,
            applied,
            names_path,
            monitor_names,
            faults,
        };

        // A corrupt file leaves the store read-only. Do not run any migration
        // or sentinel write over data we could not parse — that is exactly how
        // an unreadable library could be replaced by an empty one.
        if store.faults.any() {
            return Ok(store);
        }

        // — Monitor-enumeration generation wipe (one-shot, user-approved)
        // First run under real-monitor identities: back up legacy data,
        // then start empty. Sentinel makes it exactly-once.
        if !data_dir.join(".monitor-enumeration-v2").exists() {
            if !store.presets.is_empty() {
                let bak = format!("presets.json.bak-{}", local_timestamp());
                let _ = std::fs::copy(&store.presets_path, store.data_dir.join(&bak));
                store.presets = Vec::new();
                store.flush()?;
            }
            if !store.pinned.is_empty() {
                let bak = format!("pins.json.bak-{}", local_timestamp());
                let _ = std::fs::copy(&store.pins_path, store.data_dir.join(&bak));
                store.pinned = HashMap::new();
                store.flush_pins()?;
            }
            let _ = std::fs::write(data_dir.join(".monitor-enumeration-v2"), b"");
        }

        let needs_migration = store.presets.iter().any(|p| p.color_model == "gain-v1");
        if needs_migration {
            // Backup with local-timestamped filename
            let bak_name = format!("presets.json.bak-{}", local_timestamp());
            let bak_path = data_dir.join(&bak_name);
            let _ = std::fs::copy(&store.presets_path, &bak_path);
            // Migrate
            for p in &mut store.presets {
                if p.color_model == "gain-v1" {
                    p.brightness = 50.0;
                    p.contrast = 50.0;
                    p.color_model = "nvcp-v1".into();
                }
            }
            store.flush()?;
        }

        // — Global-presets migration: strip edid_id from stored presets ------
        // serde silently ignores the edid_id field in old data, so this
        // migration re-serialises every preset to drop the field from disk.
        if !data_dir.join(".global-presets-v1").exists() {
            if !store.presets.is_empty() {
                let bak_name = format!("presets.json.bak-{}", local_timestamp());
                let bak_path = data_dir.join(&bak_name);
                let _ = std::fs::copy(&presets_path, &bak_path);
                store.flush()?;
            }
            let _ = std::fs::write(data_dir.join(".global-presets-v1"), b"");
        }

        // — Purge stale neutral Standard presets left by old seed logic --------
        // Historical versions seeded a neutral "Standard" preset matching
        // every connected monitor. Standard is no longer seeded: a fresh
        // library starts empty and the user authors every preset. This
        // repairs existing installs: any still-pristine neutral Standard is
        // removed (delete_preset cascades pins + applied records + flushes).
        // Anything the user renamed, retuned, or created themselves is
        // untouched. Sentinel makes it exactly-once; an obsolete
        // .standard-unpin-v1 file left on disk is harmless.
        if !data_dir.join(".standard-seed-purge-v1").exists() {
            let standard_ids: Vec<String> = store
                .presets
                .iter()
                .filter(|p| is_neutral_standard(p))
                .map(|p| p.id.clone())
                .collect();
            for id in &standard_ids {
                let _ = store.delete_preset(id);
            }
            let _ = std::fs::write(data_dir.join(".standard-seed-purge-v1"), b"");
        }

        Ok(store)
    }

    /// Refuse every write while any backing file is unreadable. This is what
    /// keeps a corrupt `presets.json` from being replaced by an empty library.
    fn ensure_writable(&self) -> Result<(), StoreError> {
        match self.faults.message() {
            Some(msg) => Err(StoreError::LoadFault(format!(
                "{msg}; restore or remove it, then restart ChromaDeck"
            ))),
            None => Ok(()),
        }
    }

    /// Return all stored presets.
    pub fn list_presets(&self) -> Vec<Preset> {
        self.presets.clone()
    }

    /// Create a new preset from `input`.  Returns the created `Preset`.
    pub fn create_preset(&mut self, input: PresetInput) -> Result<Preset, StoreError> {
        self.ensure_writable()?;
        // Validate
        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput("name cannot be empty".into()));
        }
        if !(0.0..=100.0).contains(&input.brightness) {
            return Err(StoreError::InvalidInput(
                "brightness must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.0..=100.0).contains(&input.contrast) {
            return Err(StoreError::InvalidInput(
                "contrast must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.3..=2.8).contains(&input.gamma) {
            return Err(StoreError::InvalidInput(
                "gamma must be in 0.3..=2.8".into(),
            ));
        }
        if !(0.0..=100.0).contains(&input.vibrance) {
            return Err(StoreError::InvalidInput(
                "vibrance must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.0..=100.0).contains(&input.saturation) {
            return Err(StoreError::InvalidInput(
                "saturation must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.0..=359.0).contains(&input.hue_deg) {
            return Err(StoreError::InvalidInput(
                "hue_deg must be in 0.0..=359.0".into(),
            ));
        }
        for &g in &input.rgb_gains {
            if !(0.0..=10.0).contains(&g) {
                return Err(StoreError::InvalidInput(
                    "rgb_gains values must be in 0.0..=10.0".into(),
                ));
            }
        }

        // Validate color_tag
        if let Some(ref tag) = input.color_tag {
            if !is_valid_color_tag(tag) {
                return Err(StoreError::InvalidInput(
                    "color_tag must be a hex color like #rrggbb or empty".into(),
                ));
            }
        }
        // Validate tag_shape
        if let Some(ref shape) = input.tag_shape {
            if !is_valid_tag_shape(shape) {
                return Err(StoreError::InvalidInput(
                    "tag_shape must be pill, round, square, bar, diamond, hexagon, triangle, ring or empty".into(),
                ));
            }
        }

        // Handle optional ICC import
        let (icc_hash, icc_filename) = if let Some(ref src) = input.icc_path {
            let hash = self.import_icc_file(src)?;
            let filename = format!("{hash}.icc");
            (hash, filename)
        } else {
            (String::new(), String::new())
        };

        let id = uuid::Uuid::new_v4().to_string();

        let preset = Preset {
            id,
            name: input.name,
            icc_hash,
            icc_filename,
            brightness: input.brightness,
            contrast: input.contrast,
            rgb_gains: input.rgb_gains,
            gamma: input.gamma,
            vibrance: input.vibrance,
            saturation: input.saturation,
            hue_deg: input.hue_deg,
            color_model: "nvcp-v1".into(),
            color_tag: if let Some(tag) = input.color_tag {
                if tag.is_empty() { None } else { Some(tag.into()) }
            } else { None },
            tag_shape: normalise_tag_shape(input.tag_shape),
        };

        self.presets.push(preset.clone());
        self.flush()?;
        Ok(preset)
    }

    /// Update an existing preset identified by `id`.
    pub fn update_preset(
        &mut self,
        id: &str,
        input: PresetInput,
    ) -> Result<Preset, StoreError> {
        self.ensure_writable()?;
        let idx = self
            .presets
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| StoreError::NotFound(id.into()))?;

        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput("name cannot be empty".into()));
        }
        if !(0.0..=100.0).contains(&input.brightness) {
            return Err(StoreError::InvalidInput(
                "brightness must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.0..=100.0).contains(&input.contrast) {
            return Err(StoreError::InvalidInput(
                "contrast must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.3..=2.8).contains(&input.gamma) {
            return Err(StoreError::InvalidInput(
                "gamma must be in 0.3..=2.8".into(),
            ));
        }
        if !(0.0..=100.0).contains(&input.vibrance) {
            return Err(StoreError::InvalidInput(
                "vibrance must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.0..=100.0).contains(&input.saturation) {
            return Err(StoreError::InvalidInput(
                "saturation must be in 0.0..=100.0".into(),
            ));
        }
        if !(0.0..=359.0).contains(&input.hue_deg) {
            return Err(StoreError::InvalidInput(
                "hue_deg must be in 0.0..=359.0".into(),
            ));
        }

        // Validate color_tag
        if let Some(ref tag) = input.color_tag {
            if !is_valid_color_tag(tag) {
                return Err(StoreError::InvalidInput(
                    "color_tag must be a hex color like #rrggbb or empty".into(),
                ));
            }
        }
        // Validate tag_shape
        if let Some(ref shape) = input.tag_shape {
            if !is_valid_tag_shape(shape) {
                return Err(StoreError::InvalidInput(
                    "tag_shape must be pill, round, square, bar, diamond, hexagon, triangle, ring or empty".into(),
                ));
            }
        }

        // Handle optional ICC import (new path provided) or keep existing
        let (icc_hash, icc_filename) = if let Some(ref src) = input.icc_path {
            let hash = self.import_icc_file(src)?;
            let filename = format!("{hash}.icc");
            (hash, filename)
        } else {
            (
                self.presets[idx].icc_hash.clone(),
                self.presets[idx].icc_filename.clone(),
            )
        };

        let updated = Preset {
            id: self.presets[idx].id.clone(),
            name: input.name,
            icc_hash,
            icc_filename,
            brightness: input.brightness,
            contrast: input.contrast,
            rgb_gains: input.rgb_gains,
            gamma: input.gamma,
            vibrance: input.vibrance,
            saturation: input.saturation,
            hue_deg: input.hue_deg,
            color_model: self.presets[idx].color_model.clone(),
            color_tag: if let Some(tag) = input.color_tag {
                if tag.is_empty() { None } else { Some(tag.into()) }
            } else { None },
            tag_shape: normalise_tag_shape(input.tag_shape),
        };

        self.presets[idx] = updated.clone();
        self.flush()?;
        Ok(updated)
    }

    /// Delete a preset by `id`. Returns the deleted preset.
    pub fn delete_preset(&mut self, id: &str) -> Result<Preset, StoreError> {
        self.ensure_writable()?;
        let idx = self
            .presets
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| StoreError::NotFound(id.into()))?;

        let removed = self.presets.remove(idx);
        let pinned_gone = self.pinned.values().any(|v| v == id);
        if pinned_gone {
            self.pinned.retain(|_, v| v != id);
        }
        let applied_gone = self.applied.values().any(|v| v == id);
        if applied_gone {
            self.applied.retain(|_, v| v != id);
        }
        self.flush()?;
        if pinned_gone {
            self.flush_pins()?;
        }
        if applied_gone {
            self.flush_applied()?;
        }
        Ok(removed)
    }

    /// Import an ICC profile from `src_path`, copying it into the store and
    /// returning its SHA-256 hex hash.
    pub fn import_icc(&mut self, src_path: &str) -> Result<String, StoreError> {
        self.import_icc_file(src_path)
    }

    /// Internal: copy + hash an ICC file.
    fn import_icc_file(&self, src_path: &str) -> Result<String, StoreError> {
        let src = PathBuf::from(src_path);

        if !src.exists() {
            return Err(StoreError::InvalidInput(format!(
                "ICC file not found: {src_path}"
            )));
        }
        if src.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
            return Err(StoreError::InvalidInput(format!(
                "ICC file is empty: {src_path}"
            )));
        }

        let data = std::fs::read(&src)?;
        use sha2::{Digest, Sha256};
        let hash = hex::encode(Sha256::digest(&data));

        let dest = self.profiles_dir.join(format!("{hash}.icc"));
        if !dest.exists() {
            std::fs::copy(&src, &dest)?;
        }

        Ok(hash)
    }

    /// Persist the in-memory preset list to disk atomically.
    fn flush(&self) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let json = serde_json::to_string_pretty(&self.presets)?;
        let tmp = self.data_dir.join("presets.json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &self.presets_path)?;
        Ok(())
    }

    /// Pin a preset to a monitor. Returns error when preset does not exist.
    pub fn pin_preset(&mut self, edid_id: &str, preset_id: &str) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let _ = self
            .presets
            .iter()
            .find(|p| p.id == preset_id)
            .ok_or_else(|| StoreError::NotFound(preset_id.into()))?;
        self.pinned.insert(edid_id.into(), preset_id.into());
        self.flush_pins()
    }

    /// Remove the pin for a monitor (no-op when absent).
    pub fn unpin_monitor(&mut self, edid_id: &str) {
        if self.ensure_writable().is_err() {
            return;
        }
        if self.pinned.remove(edid_id).is_some() {
            let _ = self.flush_pins();
        }
    }

    /// Return a copy of the current pin map (edid_id -> preset_id).
    pub fn list_pins(&self) -> HashMap<String, String> {
        self.pinned.clone()
    }

    /// Set (or clear, when the trimmed alias is empty) a monitor's display
    /// name. Rejects aliases longer than 64 characters.
    pub fn set_monitor_name(&mut self, edid_id: &str, alias: &str) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let trimmed = alias.trim();
        if trimmed.chars().count() > 64 {
            return Err(StoreError::InvalidInput(
                "monitor name must be 64 characters or fewer".into(),
            ));
        }
        if trimmed.is_empty() {
            if self.monitor_names.remove(edid_id).is_some() {
                let _ = self.flush_names();
            }
            return Ok(());
        }
        self.monitor_names.insert(edid_id.into(), trimmed.into());
        self.flush_names()
    }

    /// Return a copy of the monitor alias map (edid_id -> alias).
    pub fn list_monitor_names(&self) -> HashMap<String, String> {
        self.monitor_names.clone()
    }

    /// Record a manual preset application for a monitor.
    /// Flushes to applied.json atomically.
    pub fn record_applied(&mut self, edid_id: &str, preset_id: &str) -> Result<(), StoreError> {
        self.ensure_writable()?;
        self.applied.insert(edid_id.into(), preset_id.into());
        self.flush_applied()
    }

    /// Clear the applied record for a monitor (e.g. after reset).
    /// No-op when no record exists. Flushes only on change.
    pub fn clear_applied(&mut self, edid_id: &str) {
        if self.ensure_writable().is_err() {
            return;
        }
        if self.applied.remove(edid_id).is_some() {
            let _ = self.flush_applied();
        }
    }

    /// Return a copy of the applied map (edid_id -> preset_id).
    pub fn list_applied(&self) -> HashMap<String, String> {
        self.applied.clone()
    }

    /// Every monitor that currently references `preset_id`, as the union of
    /// pins and applied records (sorted, de-duplicated). Captured before a
    /// preset delete so the affected displays can be restored through the
    /// backend abstraction.
    pub fn monitors_using(&self, preset_id: &str) -> Vec<String> {
        let mut edids: Vec<String> = self
            .pinned
            .iter()
            .filter(|(_, id)| id.as_str() == preset_id)
            .map(|(edid, _)| edid.clone())
            .chain(
                self.applied
                    .iter()
                    .filter(|(_, id)| id.as_str() == preset_id)
                    .map(|(edid, _)| edid.clone()),
            )
            .collect();
        edids.sort();
        edids.dedup();
        edids
    }

    /// Atomically persist the applied map to `applied.json`.
    fn flush_applied(&self) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let json = serde_json::to_string_pretty(&self.applied)?;
        let tmp = self.data_dir.join("applied.json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &self.applied_path)?;
        Ok(())
    }

    /// Atomically persist the alias map to `monitor_names.json`.
    fn flush_names(&self) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let json = serde_json::to_string_pretty(&self.monitor_names)?;
        let tmp = self.data_dir.join("monitor_names.json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &self.names_path)?;
        Ok(())
    }

    /// Atomically persist the pin map to `pins.json`.
    fn flush_pins(&self) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let json = serde_json::to_string_pretty(&self.pinned)?;
        let tmp = self.data_dir.join("pins.json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &self.pins_path)?;
        Ok(())
    }
}

// --- Default app data directory -------------------------------------------

/// Return the default store path.
///
/// Precedence:
/// 1. `CHROMADECK_DATA_DIR` env var (explicit override; blank = ignored).
/// 2. Portable mode: a file named `portable` (or `portable.txt`) sitting
///    beside the executable keeps all data in `<exe-dir>/data`, so the
///    portable ZIP leaves no trace outside its own folder. Installed and
///    dev builds ship no marker and are unaffected.
/// 3. Otherwise `%LOCALAPPDATA%/ChromaDeck`.
pub fn default_store_path() -> PathBuf {
    if let Ok(dir) = std::env::var("CHROMADECK_DATA_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(portable) = portable_data_dir(dir) {
                return portable;
            }
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ChromaDeck")
}

/// Portable data dir for an executable directory: `Some(<dir>/data)` when
/// a `portable` / `portable.txt` marker file is present, else `None`.
/// Split out for unit testing (`current_exe` can't be faked).
fn portable_data_dir(exe_dir: &Path) -> Option<PathBuf> {
    if exe_dir.join("portable").exists() || exe_dir.join("portable.txt").exists() {
        Some(exe_dir.join("data"))
    } else {
        None
    }
}

// --- Tauri commands -------------------------------------------------------

use std::sync::Mutex;

/// Wrapper for Tauri-managed state (Mutex for thread safety).
pub struct AppStore(pub Mutex<Store>);

#[tauri::command]
pub fn list_presets_cmd(state: tauri::State<'_, AppStore>) -> Result<Vec<Preset>, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    Ok(store.list_presets())
}

#[tauri::command]
pub fn create_preset_cmd(
    state: tauri::State<'_, AppStore>,
    input: PresetInput,
) -> Result<Preset, String> {
    let mut store = state.0.lock().map_err(|e| e.to_string())?;
    store.create_preset(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_preset_cmd(
    state: tauri::State<'_, AppStore>,
    id: String,
    input: PresetInput,
) -> Result<Preset, String> {
    let mut store = state.0.lock().map_err(|e| e.to_string())?;
    store.update_preset(&id, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_preset_cmd(
    state: tauri::State<'_, AppStore>,
    id: String,
) -> Result<Preset, String> {
    // Capture affected displays before the delete cascades pins/applied.
    let (removed, affected) = {
        let mut store = state.0.lock().map_err(|e| e.to_string())?;
        let affected = store.monitors_using(&id);
        let removed = store.delete_preset(&id).map_err(|e| e.to_string())?;
        (removed, affected)
    };

    // Removing a preset restores every display that referenced it, with the
    // same backend path as `reset_monitor` (parity with explicit Reset).
    // Restore is best-effort: the delete itself already succeeded, and a
    // disconnected display simply returns an offline result.
    if !affected.is_empty() {
        let api = crate::color::RealColorApi;
        let nv = crate::nvapi::RealNvapi;
        for (edid_id, result) in crate::color::restore_monitors(&api, &nv, &affected) {
            if let Some(error) = result.error {
                eprintln!(
                    "ChromaDeck: preset {id} removed but {edid_id} could not be restored: {error}"
                );
            }
        }
    }

    Ok(removed)
}

#[tauri::command]
pub fn import_icc_cmd(
    state: tauri::State<'_, AppStore>,
    src_path: String,
) -> Result<String, String> {
    let mut store = state.0.lock().map_err(|e| e.to_string())?;
    store.import_icc(&src_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pin_preset_cmd(
    state: tauri::State<'_, AppStore>,
    edid_id: String,
    preset_id: String,
) -> Result<(), String> {
    let mut store = state.0.lock().map_err(|e| e.to_string())?;
    store.pin_preset(&edid_id, &preset_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unpin_monitor_cmd(state: tauri::State<'_, AppStore>, edid_id: String) {
    if let Ok(mut store) = state.0.lock() {
        store.unpin_monitor(&edid_id);
    }
}

#[tauri::command]
pub fn list_pins_cmd(
    state: tauri::State<'_, AppStore>,
) -> Result<HashMap<String, String>, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    Ok(store.list_pins())
}

#[tauri::command]
pub fn list_applied_cmd(
    state: tauri::State<'_, AppStore>,
) -> Result<HashMap<String, String>, String> {
    let store = state.0.lock().map_err(|e| e.to_string())?;
    Ok(store.list_applied())
}

#[tauri::command]
pub fn set_monitor_name_cmd(
    state: tauri::State<'_, AppStore>,
    edid_id: String,
    alias: String,
) -> Result<(), String> {
    let mut store = state.0.lock().map_err(|e| e.to_string())?;
    store.set_monitor_name(&edid_id, &alias).map_err(|e| e.to_string())
}
