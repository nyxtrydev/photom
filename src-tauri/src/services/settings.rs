//! Application settings: tolerant parsing, validation and migration. Persistence (Tauri store
//! plugin) lives in `commands/settings.rs`; everything here is pure and unit-tested.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::models::dto::{DevicePref, ModelKind};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub modified: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub theme: Theme,
    pub autosave_seconds: u32,
    pub recent_projects_limit: u32,
    pub default_export_folder: Option<String>,
    pub model_type: ModelKind,
    pub processing: DevicePref,
    /// action id -> key combos. Missing actions use the built-in defaults.
    pub shortcuts: BTreeMap<String, Vec<String>>,
    /// Opaque until Phase 4 defines `ExportPreset`.
    pub export_presets: Vec<Value>,
    /// Custom shadow presets (validated by `commands::shadow`).
    pub shadow_presets: Vec<Value>,
    pub default_preset: Option<String>,
    pub last_used_folders: BTreeMap<String, String>,
    pub undo_depth: u32,
    /// Warn/refuse above this many megapixels.
    pub pixel_limit_mp: u32,
    /// Largest upscaled result allowed, in megapixels.
    pub upscale_max_mp: u32,
    pub embed_originals: bool,
    /// Parallel image decode/encode workers for batch export (1 or 2).
    pub export_concurrency: u32,
    pub recent_projects: Vec<RecentProject>,
    /// The first-run "install recommended models" offer has been answered (or skipped).
    pub models_onboarding_done: bool,
    /// Advanced: catalog location for restricted networks (https only). `None` = built-in.
    pub models_catalog_url: Option<String>,
    /// Advanced: one extra host model files may be downloaded from.
    pub models_extra_host: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            theme: Theme::System,
            autosave_seconds: 60,
            recent_projects_limit: 10,
            default_export_folder: None,
            model_type: ModelKind::Fast,
            processing: DevicePref::Cpu,
            shortcuts: BTreeMap::new(),
            export_presets: Vec::new(),
            shadow_presets: Vec::new(),
            default_preset: None,
            last_used_folders: BTreeMap::new(),
            undo_depth: 50,
            pixel_limit_mp: 100,
            upscale_max_mp: 100,
            embed_originals: true,
            export_concurrency: 1,
            recent_projects: Vec::new(),
            models_onboarding_done: false,
            models_catalog_url: None,
            models_extra_host: None,
        }
    }
}

/// Upgrade stored settings of any older schema to the current one.
/// - v0: `autosaveInterval` was the name of `autosaveSeconds`; theme `"auto"` meant `"system"`.
pub fn migrate(mut v: Value) -> Value {
    let Some(obj) = v.as_object_mut() else {
        return json!({});
    };
    let version = obj
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if version < 1 {
        if let Some(old) = obj.remove("autosaveInterval") {
            obj.entry("autosaveSeconds").or_insert(old);
        }
        if obj.get("theme").and_then(Value::as_str) == Some("auto") {
            obj.insert("theme".into(), json!("system"));
        }
    }
    obj.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    v
}

fn take<T: DeserializeOwned>(obj: &Map<String, Value>, key: &str) -> Option<T> {
    obj.get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// Parse stored JSON field by field: one bad value falls back to its default instead of
/// discarding every setting.
pub fn parse(raw: Value) -> Settings {
    let migrated = migrate(raw);
    let Some(obj) = migrated.as_object() else {
        return Settings::default();
    };
    let d = Settings::default();
    validate(Settings {
        schema_version: SCHEMA_VERSION,
        theme: take(obj, "theme").unwrap_or(d.theme),
        autosave_seconds: take(obj, "autosaveSeconds").unwrap_or(d.autosave_seconds),
        recent_projects_limit: take(obj, "recentProjectsLimit").unwrap_or(d.recent_projects_limit),
        default_export_folder: take(obj, "defaultExportFolder").unwrap_or(d.default_export_folder),
        model_type: take(obj, "modelType").unwrap_or(d.model_type),
        processing: take(obj, "processing").unwrap_or(d.processing),
        shortcuts: take(obj, "shortcuts").unwrap_or(d.shortcuts),
        export_presets: take(obj, "exportPresets").unwrap_or(d.export_presets),
        shadow_presets: take(obj, "shadowPresets").unwrap_or(d.shadow_presets),
        default_preset: take(obj, "defaultPreset").unwrap_or(d.default_preset),
        last_used_folders: take(obj, "lastUsedFolders").unwrap_or(d.last_used_folders),
        undo_depth: take(obj, "undoDepth").unwrap_or(d.undo_depth),
        pixel_limit_mp: take(obj, "pixelLimitMp").unwrap_or(d.pixel_limit_mp),
        upscale_max_mp: take(obj, "upscaleMaxMp").unwrap_or(d.upscale_max_mp),
        embed_originals: take(obj, "embedOriginals").unwrap_or(d.embed_originals),
        export_concurrency: take(obj, "exportConcurrency").unwrap_or(d.export_concurrency),
        recent_projects: take(obj, "recentProjects").unwrap_or(d.recent_projects),
        models_onboarding_done: take(obj, "modelsOnboardingDone")
            .unwrap_or(d.models_onboarding_done),
        models_catalog_url: take(obj, "modelsCatalogUrl").unwrap_or(d.models_catalog_url),
        models_extra_host: take(obj, "modelsExtraHost").unwrap_or(d.models_extra_host),
    })
}

fn clean_path(p: Option<String>) -> Option<String> {
    p.filter(|s| !s.trim().is_empty() && s.len() <= 4096)
}

/// Clamp every field into its allowed range.
pub fn validate(mut s: Settings) -> Settings {
    s.schema_version = SCHEMA_VERSION;
    s.autosave_seconds = s.autosave_seconds.clamp(10, 3600);
    s.recent_projects_limit = s.recent_projects_limit.clamp(1, 50);
    s.undo_depth = s.undo_depth.clamp(1, 500);
    s.pixel_limit_mp = s.pixel_limit_mp.clamp(1, 1000);
    s.upscale_max_mp = s.upscale_max_mp.clamp(1, 1000);
    s.export_concurrency = s.export_concurrency.clamp(1, 2);
    s.default_export_folder = clean_path(s.default_export_folder);
    s.models_catalog_url = s
        .models_catalog_url
        .and_then(|u| crate::model_hub::config::clean_catalog_url(&u));
    s.models_extra_host = s
        .models_extra_host
        .and_then(|h| crate::model_hub::config::clean_host(&h));
    s.default_preset = s.default_preset.filter(|p| !p.is_empty() && p.len() <= 100);

    s.shortcuts = s
        .shortcuts
        .into_iter()
        .filter(|(k, _)| !k.is_empty() && k.len() <= 40)
        .take(100)
        .map(|(k, v)| {
            let combos = v
                .into_iter()
                .filter(|c| !c.is_empty() && c.len() <= 40)
                .take(4)
                .collect();
            (k, combos)
        })
        .collect();
    s.export_presets.truncate(50);
    s.shadow_presets.truncate(50);
    s.last_used_folders = s
        .last_used_folders
        .into_iter()
        .filter(|(k, v)| k.len() <= 40 && !v.is_empty() && v.len() <= 4096)
        .take(20)
        .collect();
    s.recent_projects.truncate(s.recent_projects_limit as usize);
    s
}

/// Insert (or move to front) a recent project, then enforce the configured limit.
pub fn add_recent(s: &mut Settings, entry: RecentProject) {
    s.recent_projects.retain(|r| r.path != entry.path);
    s.recent_projects.insert(0, entry);
    s.recent_projects.truncate(s.recent_projects_limit as usize);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_garbage_input_gives_defaults() {
        assert_eq!(parse(json!({})), Settings::default());
        assert_eq!(parse(json!("nonsense")), Settings::default());
        assert_eq!(parse(Value::Null), Settings::default());
    }

    #[test]
    fn one_bad_field_does_not_discard_the_rest() {
        let s = parse(json!({"theme": "purple", "autosaveSeconds": 120, "modelType": "quality"}));
        assert_eq!(s.theme, Theme::System); // invalid -> default
        assert_eq!(s.autosave_seconds, 120);
        assert_eq!(s.model_type, ModelKind::Quality);
    }

    #[test]
    fn values_are_clamped_into_range() {
        let s = parse(json!({
            "autosaveSeconds": 1, "recentProjectsLimit": 9999, "undoDepth": 0,
            "pixelLimitMp": 999999, "upscaleMaxMp": 0, "defaultExportFolder": "   "
        }));
        assert_eq!(s.autosave_seconds, 10);
        assert_eq!(s.recent_projects_limit, 50);
        assert_eq!(s.undo_depth, 1);
        assert_eq!(s.pixel_limit_mp, 1000);
        assert_eq!(s.upscale_max_mp, 1);
        assert_eq!(parse(json!({})).upscale_max_mp, 100);
        assert_eq!(s.default_export_folder, None);
    }

    #[test]
    fn the_first_run_flag_defaults_off_and_is_kept() {
        assert!(!parse(json!({})).models_onboarding_done);
        assert!(parse(json!({"modelsOnboardingDone": true})).models_onboarding_done);
        assert!(!parse(json!({"modelsOnboardingDone": "yes"})).models_onboarding_done);
    }

    #[test]
    fn advanced_model_settings_are_validated() {
        let s = parse(json!({
            "modelsCatalogUrl": "http://insecure.example/c.json",
            "modelsExtraHost": "https://not-a-host.example/path",
        }));
        assert_eq!(s.models_catalog_url, None);
        assert_eq!(s.models_extra_host, None);
        let s = parse(json!({
            "modelsCatalogUrl": "https://mirror.example/c.json",
            "modelsExtraHost": " Mirror.Example ",
        }));
        assert_eq!(
            s.models_catalog_url.as_deref(),
            Some("https://mirror.example/c.json")
        );
        assert_eq!(s.models_extra_host.as_deref(), Some("mirror.example"));
    }

    #[test]
    fn migrates_v0_names() {
        let s = parse(json!({"autosaveInterval": 300, "theme": "auto"}));
        assert_eq!(s.autosave_seconds, 300);
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn round_trips_through_json() {
        let mut s = Settings {
            theme: Theme::Dark,
            default_export_folder: Some("/tmp/out".into()),
            ..Settings::default()
        };
        s.shortcuts.insert("undo".into(), vec!["mod+z".into()]);
        assert_eq!(parse(serde_json::to_value(&s).unwrap()), s);
    }

    #[test]
    fn shortcut_map_is_bounded() {
        let mut s = Settings::default();
        s.shortcuts
            .insert("a".into(), (0..10).map(|i| format!("k{i}")).collect());
        s.shortcuts.insert(String::new(), vec!["x".into()]);
        let v = validate(s);
        assert_eq!(v.shortcuts["a"].len(), 4);
        assert!(!v.shortcuts.contains_key(""));
    }

    fn recent(path: &str) -> RecentProject {
        RecentProject {
            path: path.into(),
            name: path.into(),
            modified: "t".into(),
            thumbnail: None,
        }
    }

    #[test]
    fn recent_list_dedupes_moves_to_front_and_respects_the_limit() {
        let mut s = Settings {
            recent_projects_limit: 3,
            ..Settings::default()
        };
        for p in ["a", "b", "c", "a", "d"] {
            add_recent(&mut s, recent(p));
        }
        let order: Vec<_> = s.recent_projects.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(order, ["d", "a", "c"]);
    }

    #[test]
    fn lowering_the_limit_trims_the_list() {
        let mut s = Settings::default();
        for p in ["a", "b", "c", "d"] {
            add_recent(&mut s, recent(p));
        }
        s.recent_projects_limit = 2;
        assert_eq!(validate(s).recent_projects.len(), 2);
    }
}
