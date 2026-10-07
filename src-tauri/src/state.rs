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
    pub hub: Arc<crate::model_hub::ModelHub>,
    pub installer: Arc<crate::model_hub::installer::Installer>,
    /// Warm ONNX sessions of hub models that features share (see `model_hub::session_cache`).
    pub sessions: Arc<crate::model_hub::session_cache::SessionCache<ort::session::Session>>,
    pub settings: Arc<RwLock<Settings>>,
    pub jobs: Arc<JobQueue>,
    pub history: Arc<Mutex<HistoryStore>>,
    /// Upscale results waiting for Keep or Discard.
    pub upscale: crate::services::upscale::UpscaleStore,
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

    /// File of a background-removal model: the hub's copy (bundled, downloaded or imported) first,
    /// then whatever the legacy lookup finds.
    pub fn locate_model(&self, kind: crate::models::dto::ModelKind) -> Option<PathBuf> {
        use crate::model_hub::hub::{BG_FAST, BG_QUALITY};
        use crate::models::dto::ModelKind;
        let id = match kind {
            ModelKind::Fast => BG_FAST,
            ModelKind::Quality => BG_QUALITY,
        };
        self.hub
            .model_path(id)
            .ok()
            .or_else(|| self.models.locate(kind))
    }

    pub fn require_model(
        &self,
        kind: crate::models::dto::ModelKind,
    ) -> crate::models::error::AppResult<PathBuf> {
        self.locate_model(kind)
            .ok_or_else(|| self.models.require(kind).unwrap_err())
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().map(|s| s.clone()).unwrap_or_default()
    }

    /// Pixel cap derived from the "pixel limit" setting (megapixels).
    pub fn pixel_limit(&self) -> u64 {
        u64::from(self.settings().pixel_limit_mp) * 1_000_000
    }
}
