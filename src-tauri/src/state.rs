use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use crate::infra::job_queue::JobQueue;
use crate::infra::model_manager::ModelManager;
use crate::services::history::HistoryStore;
use crate::services::import::ImageRegistry;
use crate::services::inference::InferenceEngine;
use crate::services::settings::Settings;

/// Shared backend state managed by Tauri. Cheap to clone (all Arcs / paths).
#[derive(Clone)]
pub struct AppState {
    pub images: ImageRegistry,
    pub engine: Arc<InferenceEngine>,
    pub models: ModelManager,
    pub settings: Arc<RwLock<Settings>>,
    pub jobs: Arc<JobQueue>,
    pub history: Arc<Mutex<HistoryStore>>,
    /// The update found by the last "Check for updates" (kept so installing does not re-check).
    pub pending_update: crate::commands::updates::PendingUpdate,
    /// A `.photom` file the OS asked us to open before the UI was ready to receive events.
    pub launch_file: Arc<Mutex<Option<PathBuf>>>,
    /// Set once the frontend has asked for the launch file; later opens are sent as events.
    pub frontend_ready: Arc<AtomicBool>,
    /// Disposable cache: thumbnails, masks, previews, extracted projects.
    pub cache_dir: PathBuf,
    /// Durable data: autosaves, recent-project thumbnails, user-imported models.
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn thumbs_dir(&self) -> PathBuf {
        self.cache_dir.join("thumbs")
    }
    pub fn masks_dir(&self) -> PathBuf {
        self.cache_dir.join("masks")
    }
    pub fn projects_dir(&self) -> PathBuf {
        self.cache_dir.join("projects")
    }
    pub fn autosave_dir(&self) -> PathBuf {
        self.data_dir.join("autosave")
    }
    pub fn recent_dir(&self) -> PathBuf {
        self.data_dir.join("recent")
    }
    pub fn history_dir(&self) -> PathBuf {
        self.data_dir.join("history")
    }
    pub fn user_models_dir(&self) -> PathBuf {
        self.data_dir.join("models")
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().map(|s| s.clone()).unwrap_or_default()
    }

    /// Pixel cap derived from the "pixel limit" setting (megapixels).
    pub fn pixel_limit(&self) -> u64 {
        u64::from(self.settings().pixel_limit_mp) * 1_000_000
    }
}
