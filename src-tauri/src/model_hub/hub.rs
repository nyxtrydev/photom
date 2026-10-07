//! `ModelHub`: the catalog merged with what is installed and what is currently happening.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use chrono::Utc;
use serde::Serialize;

use super::config;
use super::manifest::{self, Catalog, CatalogModel, License, Requirements};
use super::registry::{resolve_path, InstalledRecord, ModelSource, ModelState, Registry};
use crate::infra::model_manager::ModelManager;
use crate::models::dto::ModelKind;
use crate::models::error::{AppError, AppResult};

/// Sends an event to the UI. Injected so the hub is testable without a Tauri app.
pub type Emitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// Ids of the two background-removal models that the older (pre-hub) code manages itself.
pub const CATALOG_CACHE_FILE: &str = "catalog.cache.json";
pub const BG_FAST: &str = "bgremoval-fast";
pub const BG_QUALITY: &str = "bgremoval-quality";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSource {
    Remote,
    Bundled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub source: CatalogSource,
    pub generated_at: String,
    /// Set when a remote catalog was rejected and the bundled one is shown instead.
    pub warning: Option<String>,
}

/// What the UI sees for one model.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub feature: String,
    pub version: String,
    pub description: String,
    pub size_bytes: u64,
    /// Catalog hash of the model file (all zeros while the real file is not published).
    pub sha256: String,
    pub license: License,
    pub requirements: Requirements,
    pub recommended: bool,
    pub depends_on: Vec<String>,
    pub state: ModelState,
    pub installed_version: Option<String>,
    pub source: Option<ModelSource>,
    /// False for imported files that could not be checked against the catalog hash.
    pub verified: bool,
    /// Whether a download is possible (real hash published and a location known).
    pub installable: bool,
    pub removable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub ready: bool,
    pub missing: Vec<ModelInfo>,
}

struct Loaded {
    catalog: Catalog,
    status: CatalogStatus,
}

pub type UnloadHook = Arc<dyn Fn(&str) + Send + Sync>;

pub struct ModelHub {
    models_dir: PathBuf,
    locator: ModelManager,
    loaded: RwLock<Loaded>,
    registry: Mutex<Registry>,
    transient: Mutex<HashMap<String, ModelState>>,
    emit: Emitter,
    unload_hooks: Mutex<Vec<UnloadHook>>,
    key: [u8; 32],
    https_only: bool,
}

impl ModelHub {
    /// Production constructor: bundled catalog, embedded public key.
    pub fn new(models_dir: PathBuf, locator: ModelManager, emit: Emitter) -> Self {
        Self::with_catalog(
            models_dir,
            locator,
            emit,
            config::BUNDLED_CATALOG,
            &config::CATALOG_PUBLIC_KEY,
        )
    }

    pub fn with_catalog(
        models_dir: PathBuf,
        locator: ModelManager,
        emit: Emitter,
        catalog_json: &str,
        key: &[u8; 32],
    ) -> Self {
        Self::with_catalog_opts(models_dir, locator, emit, catalog_json, key, true)
    }

    /// `https_only = false` is for tests that download from a local mock server.
    pub fn with_catalog_opts(
        models_dir: PathBuf,
        locator: ModelManager,
        emit: Emitter,
        catalog_json: &str,
        key: &[u8; 32],
        https_only: bool,
    ) -> Self {
        let loaded = match manifest::parse_verified_opts(catalog_json, key, https_only) {
            Ok(catalog) => {
                let generated_at = catalog.generated_at.clone();
                Loaded {
                    catalog,
                    status: CatalogStatus {
                        source: CatalogSource::Bundled,
                        generated_at,
                        warning: None,
                    },
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "bundled model catalog rejected");
                Loaded {
                    catalog: Catalog {
                        schema_version: config::SCHEMA_VERSION,
                        generated_at: String::new(),
                        models: Vec::new(),
                        signature: String::new(),
                    },
                    status: CatalogStatus {
                        source: CatalogSource::Bundled,
                        generated_at: String::new(),
                        warning: Some(e.to_string()),
                    },
                }
            }
        };
        let mut loaded = loaded;
        // A previously downloaded catalog wins when it verifies and is newer than the bundled one.
        if let Ok(text) = std::fs::read_to_string(models_dir.join(CATALOG_CACHE_FILE)) {
            match manifest::parse_verified_opts(&text, key, https_only) {
                Ok(c) if c.generated_at > loaded.catalog.generated_at => {
                    loaded.status = CatalogStatus {
                        source: CatalogSource::Remote,
                        generated_at: c.generated_at.clone(),
                        warning: None,
                    };
                    loaded.catalog = c;
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "ignoring cached model catalog"),
            }
        }
        let registry = Registry::load(&models_dir);
        Self {
            models_dir,
            locator,
            loaded: RwLock::new(loaded),
            registry: Mutex::new(registry),
            transient: Mutex::new(HashMap::new()),
            emit,
            unload_hooks: Mutex::new(Vec::new()),
            key: *key,
            https_only,
        }
    }

    pub fn https_only(&self) -> bool {
        self.https_only
    }

    /// Run `hook(model_id)` whenever a model's file is about to go away or be replaced, so
    /// whoever holds a loaded session can drop it first.
    pub fn add_unload_hook(&self, hook: UnloadHook) {
        if let Ok(mut h) = self.unload_hooks.lock() {
            h.push(hook);
        }
    }

    /// Tell every holder of a session for `id` to let go of it.
    pub fn invalidate(&self, id: &str) {
        let hooks = self
            .unload_hooks
            .lock()
            .map(|h| h.clone())
            .unwrap_or_default();
        for hook in hooks {
            hook(id);
        }
    }

    /// The installed record for `id` (None when nothing usable is installed).
    pub fn record(&self, id: &str) -> Option<InstalledRecord> {
        self.record_for(id)
    }

    pub fn installed_version(&self, id: &str) -> Option<String> {
        self.record_for(id).map(|r| r.version)
    }

    /// Forget a model in the registry (the caller deletes its files).
    pub fn unregister(&self, id: &str) -> AppResult<Option<InstalledRecord>> {
        self.registry
            .lock()
            .map_err(|_| AppError::Internal("registry lock poisoned".into()))?
            .remove(id)
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.key
    }

    pub fn emit(&self, name: &str, payload: serde_json::Value) {
        (self.emit)(name, payload);
    }

    /// Install a newly downloaded (already verified) catalog and remember it for next start.
    pub fn set_catalog(&self, catalog: Catalog, raw_json: &str) -> AppResult<()> {
        let generated_at = catalog.generated_at.clone();
        {
            let mut l = self
                .loaded
                .write()
                .map_err(|_| AppError::Internal("catalog lock poisoned".into()))?;
            if catalog.generated_at < l.catalog.generated_at {
                return Err(AppError::InvalidInput(
                    "the downloaded catalog is older than the one in use".into(),
                ));
            }
            l.catalog = catalog;
            l.status = CatalogStatus {
                source: CatalogSource::Remote,
                generated_at,
                warning: None,
            };
        }
        std::fs::create_dir_all(&self.models_dir)?;
        let tmp = self.models_dir.join("catalog.cache.json.tmp");
        std::fs::write(&tmp, raw_json)?;
        std::fs::rename(&tmp, self.models_dir.join(CATALOG_CACHE_FILE))?;
        self.emit("catalog:updated", serde_json::json!({}));
        Ok(())
    }

    /// Show why the catalog could not be refreshed (offline, rejected, ...).
    pub fn set_catalog_warning(&self, warning: Option<String>) {
        if let Ok(mut l) = self.loaded.write() {
            l.status.warning = warning;
        }
    }

    pub fn catalog_models(&self) -> Vec<CatalogModel> {
        self.loaded
            .read()
            .map(|l| l.catalog.models.clone())
            .unwrap_or_default()
    }

    /// Set a state without validation or events (startup: downloads left over from a previous
    /// run come back as Paused).
    pub fn restore_state(&self, id: &str, state: ModelState) {
        if let Ok(mut t) = self.transient.lock() {
            t.insert(id.to_string(), state);
        }
    }

    pub fn models_dir(&self) -> &std::path::Path {
        &self.models_dir
    }

    pub fn catalog_status(&self) -> CatalogStatus {
        self.loaded
            .read()
            .map(|l| l.status.clone())
            .unwrap_or(CatalogStatus {
                source: CatalogSource::Bundled,
                generated_at: String::new(),
                warning: None,
            })
    }

    pub fn catalog_model(&self, id: &str) -> Option<CatalogModel> {
        self.loaded
            .read()
            .ok()?
            .catalog
            .models
            .iter()
            .find(|m| m.id == id)
            .cloned()
    }

    /// The installed record for `id`, if its file is really there. Background-removal models that
    /// ship with the app (or were imported before the hub existed) are derived on the fly.
    fn record_for(&self, id: &str) -> Option<InstalledRecord> {
        let stored = self.registry.lock().ok()?.get(id).cloned();
        if let Some(r) = stored {
            let present = resolve_path(&self.models_dir, &r).is_some_and(|p| p.is_file());
            if present {
                return Some(r);
            }
        }
        self.derived_record(id)
    }

    fn derived_record(&self, id: &str) -> Option<InstalledRecord> {
        let kind = match id {
            BG_FAST => ModelKind::Fast,
            BG_QUALITY => ModelKind::Quality,
            _ => return self.shipped_record(id),
        };
        let path = self.locator.locate(kind)?;
        let name = path.file_name()?.to_str()?.to_string();
        let model = self.catalog_model(id);
        // Only the file Photom ships is trusted; anything else was supplied by the user.
        let shipped = kind == ModelKind::Fast && !name.starts_with("custom-");
        Some(InstalledRecord {
            id: id.to_string(),
            version: model
                .as_ref()
                .map(|m| m.version.clone())
                .unwrap_or_default(),
            source: if shipped {
                ModelSource::Bundled
            } else {
                ModelSource::Imported
            },
            path: path.display().to_string(),
            sha256: shipped
                .then(|| model.as_ref().map(|m| m.sha256.clone()))
                .flatten(),
            installed_at: Utc::now(),
            verified: shipped,
        })
    }

    /// A catalog model that has no download location ships inside the app: it is installed when
    /// its file is next to the other bundled models.
    fn shipped_record(&self, id: &str) -> Option<InstalledRecord> {
        let model = self.catalog_model(id).filter(|m| m.urls.is_empty())?;
        let file = model.files.first()?;
        let path = self.locator.locate_file(&file.path)?;
        Some(InstalledRecord {
            id: id.to_string(),
            version: model.version.clone(),
            source: ModelSource::Bundled,
            path: path.display().to_string(),
            sha256: Some(file.sha256.clone()),
            installed_at: Utc::now(),
            verified: true,
        })
    }

    /// Absolute path of an imported/derived record is stored absolute; resolve both kinds.
    fn file_of(&self, r: &InstalledRecord) -> Option<PathBuf> {
        let p = match r.source {
            ModelSource::Imported if std::path::Path::new(&r.path).is_absolute() => {
                Some(PathBuf::from(&r.path))
            }
            _ => resolve_path(&self.models_dir, r),
        }?;
        p.is_file().then_some(p)
    }

    /// State with the transient map already locked by the caller.
    fn rest_state(&self, id: &str) -> ModelState {
        match self.record_for(id) {
            None => ModelState::NotInstalled,
            Some(r) => {
                let newer = self.catalog_model(id).is_some_and(|m| {
                    r.source == ModelSource::Hub && manifest::is_newer(&m.version, &r.version)
                });
                if newer {
                    ModelState::UpdateAvailable
                } else {
                    ModelState::Installed
                }
            }
        }
    }

    /// Record a finished install (the installer calls this after the atomic rename).
    pub fn register(&self, record: InstalledRecord) -> AppResult<()> {
        self.registry
            .lock()
            .map_err(|_| AppError::Internal("registry lock poisoned".into()))?
            .upsert(record)
    }

    pub fn state_of(&self, id: &str) -> ModelState {
        let transient = self.transient.lock().ok().and_then(|t| t.get(id).cloned());
        transient.unwrap_or_else(|| self.rest_state(id))
    }

    /// Move a model to a new state, refusing illegal jumps. Moving to a rest state ends the
    /// running work and falls back to whatever the registry says. Emits `model:state`.
    pub fn transition(&self, id: &str, to: ModelState) -> AppResult<ModelState> {
        if self.catalog_model(id).is_none() {
            return Err(AppError::InvalidInput(format!("unknown model '{id}'")));
        }
        let resulting = {
            let mut t = self
                .transient
                .lock()
                .map_err(|_| AppError::Internal("model state lock poisoned".into()))?;
            let current = t.get(id).cloned().unwrap_or_else(|| self.rest_state(id));
            if !current.can_become(&to) {
                return Err(AppError::InvalidInput(format!(
                    "cannot move '{id}' from {current:?} to {to:?}"
                )));
            }
            if to.is_rest() {
                t.remove(id);
                self.rest_state(id)
            } else {
                t.insert(id.to_string(), to.clone());
                to
            }
        };
        (self.emit)(
            "model:state",
            serde_json::json!({ "id": id, "state": resulting }),
        );
        Ok(resulting)
    }

    fn info(&self, m: &CatalogModel) -> ModelInfo {
        let record = self.record_for(&m.id);
        ModelInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            feature: m.feature.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            size_bytes: m.size_bytes,
            sha256: m.sha256.clone(),
            license: m.license.clone(),
            requirements: m.requirements.clone(),
            recommended: m.recommended,
            depends_on: m.depends_on.clone(),
            state: self.state_of(&m.id),
            installed_version: record.as_ref().map(|r| r.version.clone()),
            source: record.as_ref().map(|r| r.source),
            verified: record.as_ref().is_some_and(|r| r.verified),
            installable: m.installable(),
            removable: record
                .as_ref()
                .is_some_and(|r| r.source != ModelSource::Bundled),
        }
    }

    pub fn list(&self) -> Vec<ModelInfo> {
        let models = self
            .loaded
            .read()
            .map(|l| l.catalog.models.clone())
            .unwrap_or_default();
        models.iter().map(|m| self.info(m)).collect()
    }

    /// Path of an installed model's file, or `ModelMissing` carrying the model id so the UI can
    /// show the install prompt. Every feature service gets its model through this.
    pub fn model_path(&self, id: &str) -> AppResult<PathBuf> {
        self.record_for(id)
            .and_then(|r| self.file_of(&r))
            .ok_or_else(|| AppError::ModelMissing(id.to_string()))
    }

    pub fn is_ready(&self, id: &str) -> bool {
        self.model_path(id).is_ok()
    }

    /// Models a feature needs: its recommended models plus everything they depend on.
    pub fn required_for_feature(&self, feature: &str) -> AppResult<Vec<String>> {
        let models = self
            .loaded
            .read()
            .map(|l| l.catalog.models.clone())
            .unwrap_or_default();
        if !models.iter().any(|m| m.feature == feature) {
            return Err(AppError::InvalidInput(format!(
                "unknown feature '{feature}'"
            )));
        }
        let mut wanted: Vec<String> = models
            .iter()
            .filter(|m| m.feature == feature && m.recommended)
            .map(|m| m.id.clone())
            .collect();
        let mut seen: HashSet<String> = wanted.iter().cloned().collect();
        let mut i = 0;
        while i < wanted.len() {
            let deps = models
                .iter()
                .find(|m| m.id == wanted[i])
                .map(|m| m.depends_on.clone())
                .unwrap_or_default();
            for d in deps {
                if seen.insert(d.clone()) {
                    wanted.push(d);
                }
            }
            i += 1;
        }
        Ok(wanted)
    }

    /// Which of `ids` are not ready to use.
    pub fn check_models(&self, ids: &[String]) -> Requirement {
        let missing: Vec<ModelInfo> = self
            .list()
            .into_iter()
            .filter(|m| ids.contains(&m.id) && !self.is_ready(&m.id))
            .collect();
        Requirement {
            ready: missing.is_empty(),
            missing,
        }
    }

    pub fn check_requirements(&self, feature: &str) -> AppResult<Requirement> {
        Ok(self.check_models(&self.required_for_feature(feature)?))
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
