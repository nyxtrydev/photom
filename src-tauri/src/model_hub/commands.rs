//! IPC entry points of the Model Hub.

use tauri::State;

use super::hub::{CatalogStatus, ModelInfo, Requirement};
use crate::models::error::AppError;
use crate::state::AppState;

#[tauri::command]
pub fn models_list(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, AppError> {
    Ok(state.hub.list())
}

#[tauri::command]
pub fn model_catalog_status(state: State<'_, AppState>) -> Result<CatalogStatus, AppError> {
    Ok(state.hub.catalog_status())
}

#[tauri::command]
pub fn model_check_requirements(
    state: State<'_, AppState>,
    feature_id: String,
) -> Result<Requirement, AppError> {
    state.hub.check_requirements(&feature_id)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub models: Vec<ModelInfo>,
    #[serde(flatten)]
    pub status: CatalogStatus,
}

/// Download the signed catalog. Offline or rejected catalogs are reported in `warning`, not as an
/// error: the bundled/previous catalog stays in use.
#[tauri::command]
pub async fn models_refresh_catalog(state: State<'_, AppState>) -> Result<RefreshResult, AppError> {
    let status = state.installer.refresh_catalog().await;
    Ok(RefreshResult {
        models: state.hub.list(),
        status,
    })
}

#[tauri::command]
pub fn model_install(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.installer.install(&id)
}

#[tauri::command]
pub fn model_pause(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.installer.pause(&id)
}

#[tauri::command]
pub fn model_resume(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.installer.resume(&id)
}

#[tauri::command]
pub fn model_cancel(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.installer.cancel(&id)
}

#[tauri::command]
pub fn model_install_many(state: State<'_, AppState>, ids: Vec<String>) -> Result<u32, AppError> {
    state.installer.install_many(&ids)
}

#[tauri::command]
pub fn model_install_recommended(state: State<'_, AppState>) -> Result<u32, AppError> {
    state.installer.install_recommended()
}

#[tauri::command]
pub fn model_install_all(state: State<'_, AppState>) -> Result<u32, AppError> {
    state.installer.install_all()
}

/// Open the folder that holds downloaded models in the OS file manager.
#[tauri::command]
pub fn model_open_folder(state: State<'_, AppState>) -> Result<(), AppError> {
    use std::process::Command;
    let dir = state.hub.models_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&dir).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(&dir).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&dir).status();
    // explorer.exe returns 1 even on success, so only spawn failures are errors.
    status.map(|_| ()).map_err(AppError::from)
}

/// Install a model from a local file. Without `allow_unverified`, a file that does not match the
/// published checksum is refused with the `Unverified` error so the UI can ask the user.
#[tauri::command]
pub async fn model_import_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
    allow_unverified: Option<bool>,
) -> Result<(), AppError> {
    let installer = state.installer.clone();
    installer
        .import_file(&id, &path, allow_unverified.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn model_remove(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let installer = state.installer.clone();
    tokio::task::spawn_blocking(move || installer.remove(&id))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}
