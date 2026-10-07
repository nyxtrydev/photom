//! Installed-model registry (`registry.json`) and the per-model state machine.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::manifest::is_safe_relative_path;
use crate::models::error::{AppError, AppResult};

pub const REGISTRY_FILE: &str = "registry.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelSource {
    /// Shipped inside the installer; cannot be removed.
    Bundled,
    /// Downloaded through the hub and hash-verified.
    Hub,
    /// Supplied by the user from a local file.
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRecord {
    pub id: String,
    pub version: String,
    pub source: ModelSource,
    /// Relative to the models directory for hub/imported models; absolute for bundled ones.
    pub path: String,
    pub sha256: Option<String>,
    pub installed_at: DateTime<Utc>,
    /// False for imported files that could not be checked against the catalog hash.
    pub verified: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    schema_version: u32,
    models: Vec<InstalledRecord>,
}

/// Persistent set of installed models. Writes are atomic (temp file + rename).
#[derive(Debug)]
pub struct Registry {
    file: PathBuf,
    records: Vec<InstalledRecord>,
}

impl Registry {
    /// Load `<dir>/registry.json`. A missing file is an empty registry; an unreadable one is
    /// kept aside as `.corrupt` and replaced by an empty registry (models can be re-detected).
    pub fn load(dir: &Path) -> Self {
        let file = dir.join(REGISTRY_FILE);
        let records = match std::fs::read_to_string(&file) {
            Ok(text) => match serde_json::from_str::<RegistryFile>(&text) {
                Ok(f) => f.models,
                Err(e) => {
                    tracing::warn!(error = %e, "model registry unreadable; starting empty");
                    let _ = std::fs::rename(&file, file.with_extension("json.corrupt"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { file, records }
    }

    pub fn get(&self, id: &str) -> Option<&InstalledRecord> {
        self.records.iter().find(|r| r.id == id)
    }

    pub fn all(&self) -> &[InstalledRecord] {
        &self.records
    }

    pub fn upsert(&mut self, record: InstalledRecord) -> AppResult<()> {
        match self.records.iter_mut().find(|r| r.id == record.id) {
            Some(slot) => *slot = record,
            None => self.records.push(record),
        }
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> AppResult<Option<InstalledRecord>> {
        let Some(pos) = self.records.iter().position(|r| r.id == id) else {
            return Ok(None);
        };
        let gone = self.records.remove(pos);
        self.save()?;
        Ok(Some(gone))
    }

    fn save(&self) -> AppResult<()> {
        let body = serde_json::to_vec_pretty(&RegistryFile {
            schema_version: 1,
            models: self.records.clone(),
        })
        .map_err(|e| AppError::Internal(e.to_string()))?;
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

/// Where a record's file lives. Hub/imported paths must stay inside the models directory.
pub fn resolve_path(models_dir: &Path, record: &InstalledRecord) -> Option<PathBuf> {
    match record.source {
        ModelSource::Bundled => Some(PathBuf::from(&record.path)),
        _ if is_safe_relative_path(&record.path) => Some(models_dir.join(&record.path)),
        _ => None,
    }
}

/// Lifecycle of one model as seen by the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelState {
    NotInstalled,
    Queued,
    Downloading,
    Paused,
    Verifying,
    Installing,
    Installed,
    UpdateAvailable,
    Removing,
    Failed { code: String, message: String },
}

impl ModelState {
    /// States derived from the registry and catalog rather than from running work.
    pub fn is_rest(&self) -> bool {
        matches!(
            self,
            Self::NotInstalled | Self::Installed | Self::UpdateAvailable
        )
    }

    /// Whether `self -> to` is a legal step. Moving to a rest state means "work ended; fall back
    /// to what the registry says".
    pub fn can_become(&self, to: &ModelState) -> bool {
        use ModelState::*;
        let to_rest = to.is_rest();
        match self {
            NotInstalled | UpdateAvailable => matches!(to, Queued | Removing),
            Installed => matches!(to, Removing),
            Failed { .. } => matches!(to, Queued | Removing) || to_rest,
            Queued => matches!(to, Downloading | Paused | Failed { .. }) || to_rest,
            Downloading => matches!(to, Paused | Verifying | Failed { .. }) || to_rest,
            Paused => matches!(to, Queued | Downloading | Failed { .. }) || to_rest,
            Verifying => matches!(to, Installing | Downloading | Failed { .. }) || to_rest,
            Installing => matches!(to, Failed { .. }) || to_rest,
            Removing => matches!(to, Failed { .. }) || to_rest,
        }
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
