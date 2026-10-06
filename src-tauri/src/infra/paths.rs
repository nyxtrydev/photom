use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::models::error::{AppError, AppResult};

/// Rolling log directory inside the app log dir.
pub fn log_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))
}
