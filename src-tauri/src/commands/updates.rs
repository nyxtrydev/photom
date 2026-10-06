//! Opt-in, signed updates. Nothing here runs unless the user clicks "Check for updates":
//! Photom never contacts the network on its own.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::models::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

pub type PendingUpdate = Arc<Mutex<Option<Update>>>;

fn friendly(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(_) | E::Network(_) => AppError::Io(
            "Could not reach the update server. Check your internet connection and try again."
                .into(),
        ),
        E::ReleaseNotFound => {
            AppError::Io("No update information was found for this platform.".into())
        }
        other => AppError::Io(format!("The update check failed: {other}")),
    }
}

/// Check the configured endpoint once. Returns the info and, when newer, the downloadable update.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> AppResult<(UpdateInfo, Option<Update>)> {
    let mut builder = app.updater_builder();
    // Debug builds may point at a local test release; release builds only use the signed config.
    if cfg!(debug_assertions) {
        if let Ok(url) = std::env::var("PHOTOM_UPDATE_URL") {
            let url = url
                .parse()
                .map_err(|e| AppError::InvalidInput(format!("PHOTOM_UPDATE_URL: {e}")))?;
            builder = builder.endpoints(vec![url]).map_err(friendly)?;
        }
    }
    let updater = builder.build().map_err(friendly)?;
    let current = app.package_info().version.to_string();
    match updater.check().await.map_err(friendly)? {
        Some(u) => Ok((
            UpdateInfo {
                available: true,
                current_version: current,
                version: Some(u.version.clone()),
                notes: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            },
            Some(u),
        )),
        None => Ok((
            UpdateInfo {
                available: false,
                current_version: current,
                version: None,
                notes: None,
                date: None,
            },
            None,
        )),
    }
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateInfo, AppError> {
    let (info, update) = check(&app).await?;
    *state
        .pending_update
        .lock()
        .map_err(|_| AppError::Internal("update lock poisoned".into()))? = update;
    tracing::info!(available = info.available, "update check finished");
    Ok(info)
}

/// Download and install the update found by the last check (signature verified by the updater).
/// Emits `update:progress { downloaded, total }`. The frontend then offers to restart.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    let update = state
        .pending_update
        .lock()
        .map_err(|_| AppError::Internal("update lock poisoned".into()))?
        .take()
        .ok_or_else(|| AppError::InvalidInput("Check for updates first.".into()))?;
    let mut downloaded: u64 = 0;
    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit(
                    "update:progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| AppError::Io(format!("The update could not be installed: {e}")))?;
    tracing::info!("update installed");
    Ok(())
}

#[tauri::command]
pub fn restart_app(app: AppHandle, state: State<'_, AppState>) {
    state.engine.unload();
    app.restart();
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
