use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::infra::model_manager::{self, spec};
use crate::models::dto::ModelKind;
use crate::models::error::AppError;
use crate::services::inference;
use crate::services::settings::{self, Settings};
use crate::state::AppState;

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "settings";

/// Load settings from the store (tolerant + migrated). Used at startup.
pub fn load(app: &AppHandle) -> Settings {
    let raw = app
        .store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .unwrap_or_default();
    settings::parse(raw)
}

/// Validate, store in memory and write to disk.
pub fn persist(app: &AppHandle, st: &AppState, new: Settings) -> Result<Settings, AppError> {
    let valid = settings::validate(new);
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::Io(e.to_string()))?;
    store.set(
        STORE_KEY,
        serde_json::to_value(&valid).map_err(|e| AppError::Internal(e.to_string()))?,
    );
    store.save().map_err(|e| AppError::Io(e.to_string()))?;
    *st.settings
        .write()
        .map_err(|_| AppError::Internal("settings lock poisoned".into()))? = valid.clone();
    st.installer.apply_overrides(
        valid.models_catalog_url.as_deref(),
        valid.models_extra_host.as_deref(),
    )?;
    Ok(valid)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, AppError> {
    persist(&app, state.inner(), settings)
}

#[tauri::command]
pub fn remove_recent_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Settings, AppError> {
    let mut s = state.settings();
    s.recent_projects.retain(|r| r.path != path);
    persist(&app, state.inner(), s)
}

#[tauri::command]
pub fn clear_recent_projects(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Settings, AppError> {
    let mut s = state.settings();
    s.recent_projects.clear();
    persist(&app, state.inner(), s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub logs_dir: String,
    pub models: Vec<ModelInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub kind: ModelKind,
    pub file_name: String,
    pub licence: String,
    pub present: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub fn get_app_info(app: AppHandle, state: State<'_, AppState>) -> Result<AppInfo, AppError> {
    let models = [ModelKind::Fast, ModelKind::Quality]
        .into_iter()
        .map(|kind| {
            let sp = spec(kind);
            let path = state.locate_model(kind);
            ModelInfo {
                kind,
                file_name: path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| sp.primary().name.to_string()),
                licence: sp.licence.to_string(),
                present: path.is_some(),
                path: path.map(|p| p.display().to_string()),
            }
        })
        .collect();
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        logs_dir: crate::infra::paths::log_dir(&app)?.display().to_string(),
        models,
    })
}

/// Open the folder containing Photom's logs in the OS file manager.
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), AppError> {
    let dir = crate::infra::paths::log_dir(&app)?;
    std::fs::create_dir_all(&dir)?;
    super::image::open_folder(&dir)
}

/// Show a file (recent project etc.) in the OS file manager. The path must exist.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.exists() {
        return Err(AppError::InvalidInput(format!("not found: {path}")));
    }
    super::image::reveal(&p)
}

/// Copy a user-chosen `.onnx` file into the app's models folder after checking it loads.
#[tauri::command]
pub async fn import_model(
    state: State<'_, AppState>,
    kind: ModelKind,
    path: String,
) -> Result<(), AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let src = crate::services::image_io::validate_input_path(&path)?;
        if src
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("onnx")
        {
            return Err(AppError::UnsupportedFormat(
                "choose an .onnx model file".into(),
            ));
        }
        inference::validate_model(&src)?;
        let dest_dir = st.user_models_dir();
        std::fs::create_dir_all(&dest_dir)?;
        let dest = dest_dir.join(model_manager::custom_file_name(kind));
        copy_atomic(&src, &dest)?;
        tracing::info!(?kind, "model imported");
        Ok(())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

fn copy_atomic(src: &Path, dest: &Path) -> Result<(), AppError> {
    let tmp = dest.with_extension("onnx.part");
    std::fs::copy(src, &tmp)?;
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// Which of these paths still exist (recent projects whose file was moved or deleted).
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}

/// The bundled third-party licence text (resources in a packaged app, the source tree in dev).
#[tauri::command]
pub fn read_licences(app: AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    let candidates = [
        app.path()
            .resource_dir()
            .ok()
            .map(|d| d.join("resources").join("THIRD_PARTY_LICENSES.md")),
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/THIRD_PARTY_LICENSES.md")),
    ];
    let path = candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            AppError::Io("The licence file is missing from this installation.".into())
        })?;
    Ok(std::fs::read_to_string(path)?)
}
