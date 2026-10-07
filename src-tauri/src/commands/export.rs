use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::inference::run_removal;
use crate::infra::job_queue::{ItemError, JobEvents, JobSnapshot, JobStatus};
use crate::models::dto::RemoveOptions;
use crate::models::error::AppError;
use crate::services::exporter::{self, ExportOptions, ItemRequest, ItemState};
use crate::services::history::{HistoryItem, HistoryKind};
use crate::services::settings::Settings;
use crate::services::upscale;
use crate::state::AppState;

const MAX_ITEMS: usize = 5000;

/// Forwards job events to the frontend: `job:progress`, `job:item-complete`, `job:error`.
pub(super) struct TauriEvents {
    pub(super) app: AppHandle,
}

fn status_name(s: JobStatus) -> &'static str {
    match s {
        JobStatus::Running => "running",
        JobStatus::Paused => "paused",
        JobStatus::Done => "done",
        JobStatus::Cancelled => "cancelled",
    }
}

impl JobEvents for TauriEvents {
    fn progress(
        &self,
        job_id: &str,
        done: usize,
        total: usize,
        current: Option<&str>,
        status: JobStatus,
    ) {
        let _ = self.app.emit(
            "job:progress",
            json!({ "jobId": job_id, "done": done, "total": total, "currentId": current, "state": status_name(status) }),
        );
    }
    fn item_complete(&self, job_id: &str, item_id: &str, result: &Value) {
        let _ = self.app.emit(
            "job:item-complete",
            json!({ "jobId": job_id, "itemId": item_id, "result": result }),
        );
    }
    fn item_error(&self, job_id: &str, item_id: &str, error: &ItemError) {
        let _ = self.app.emit(
            "job:error",
            json!({ "jobId": job_id, "itemId": item_id, "error": error }),
        );
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItemRequest {
    pub id: String,
    #[serde(default)]
    pub state: ItemState,
}

pub(super) fn validate_items(items: &[ExportItemRequest]) -> Result<(), AppError> {
    if items.is_empty() {
        return Err(AppError::InvalidInput("Nothing to export.".into()));
    }
    if items.len() > MAX_ITEMS {
        return Err(AppError::InvalidInput(format!(
            "Too many images (max {MAX_ITEMS})."
        )));
    }
    Ok(())
}

fn history_thumbnail(st: &AppState, id: &str, img: &image::RgbaImage) -> Option<String> {
    let dir = st.history_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{id}.png"));
    image::imageops::thumbnail(img, 160, 160)
        .save_with_format(&path, image::ImageFormat::Png)
        .ok()?;
    Some(path.display().to_string())
}

/// Start a (batch) export job. Progress arrives via `job:*` events.
#[tauri::command]
pub fn export_png(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<ExportItemRequest>,
    options: ExportOptions,
) -> Result<String, AppError> {
    validate_items(&items)?;
    // Fail fast on a bad folder instead of failing every item.
    exporter::ensure_folder(&options.folder)?;
    let st = state.inner().clone();
    let total = items.len();
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();

    let labels = items
        .iter()
        .map(|i| {
            let name = st
                .images
                .get(&i.id)
                .map(|r| r.meta.name)
                .unwrap_or_else(|_| i.id.clone());
            (i.id.clone(), name)
        })
        .collect::<Vec<_>>();
    let concurrency = st.settings().export_concurrency as usize;
    let events = Arc::new(TauriEvents { app });
    let (st2, options) = (st.clone(), options);

    Ok(st
        .jobs
        .start("export", labels, concurrency, events, move |index, id| {
            let req = items
                .iter()
                .find(|i| i.id == id)
                .ok_or_else(|| AppError::Internal("item vanished".into()))?;
            let rec = st2.images.get(id)?;
            // A kept upscale replaces the picture the pipeline works on.
            let (work, work_state) = upscale::with_kept(&rec, st2.images.upscaled(id)?, &req.state);
            let (done, img) = exporter::export_item(&ItemRequest {
                rec: &work,
                state: &work_state,
                options: &options,
                index: index + 1,
                total,
                date: &date,
                pixel_limit: st2.pixel_limit(),
            })?;
            let thumb = history_thumbnail(&st2, &uuid::Uuid::new_v4().to_string(), &img);
            if let Ok(mut h) = st2.history.lock() {
                let _ = h.add(HistoryItem::new(
                    HistoryKind::Export,
                    &rec.meta.name,
                    Some(rec.source.display().to_string()),
                    Some(done.output_path.clone()),
                    thumb,
                ));
            }
            serde_json::to_value(done).map_err(|e| AppError::Internal(e.to_string()))
        }))
}

/// Batch background removal for the given images.
#[tauri::command]
pub fn remove_background_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    options: RemoveOptions,
) -> Result<String, AppError> {
    if ids.is_empty() || ids.len() > MAX_ITEMS {
        return Err(AppError::InvalidInput(
            "Choose between 1 and 5000 images.".into(),
        ));
    }
    let st = state.inner().clone();
    let labels = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                st.images
                    .get(id)
                    .map(|r| r.meta.name)
                    .unwrap_or_else(|_| id.clone()),
            )
        })
        .collect::<Vec<_>>();
    let events = Arc::new(TauriEvents { app: app.clone() });
    // The model session is shared and serialised, so one worker is the right amount of parallelism.
    let jobs = st.jobs.clone();
    Ok(
        jobs.start("removeBackground", labels, 1, events, move |_, id| {
            let mask = run_removal(&app, &st, id, options)?;
            serde_json::to_value(mask).map_err(|e| AppError::Internal(e.to_string()))
        }),
    )
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    state.jobs.cancel(&job_id)
}

#[tauri::command]
pub fn pause_job(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    state.jobs.pause(&job_id)
}

#[tauri::command]
pub fn resume_job(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    state.jobs.resume(&job_id)
}

/// Current state of a job (used when a dialog opens after progress events were already sent).
#[tauri::command]
pub fn get_job(state: State<'_, AppState>, job_id: String) -> Result<JobSnapshot, AppError> {
    state.jobs.snapshot(&job_id)
}

/// Render one image with the export settings and put it on the clipboard as PNG with alpha.
#[tauri::command]
pub async fn copy_to_clipboard(
    app: AppHandle,
    state: State<'_, AppState>,
    item: ExportItemRequest,
    options: ExportOptions,
) -> Result<(), AppError> {
    let st = state.inner().clone();
    let img = tokio::task::spawn_blocking(move || {
        let rec = st.images.get(&item.id)?;
        let (work, work_state) =
            upscale::with_kept(&rec, st.images.upscaled(&item.id)?, &item.state);
        exporter::render_item(&work, &work_state, &options, st.pixel_limit()).map(|r| r.image)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;
    let (w, h) = img.dimensions();
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(img.into_raw(), w, h))
        .map_err(|e| AppError::Io(format!("could not write to the clipboard: {e}")))
}

// ---- history ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_history(state: State<'_, AppState>) -> Vec<HistoryItem> {
    state.history.lock().map(|h| h.list()).unwrap_or_default()
}

#[tauri::command]
pub fn delete_history_item(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<HistoryItem>, AppError> {
    let mut h = state
        .history
        .lock()
        .map_err(|_| AppError::Internal("history lock poisoned".into()))?;
    h.delete(&id)?;
    Ok(h.list())
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<Vec<HistoryItem>, AppError> {
    let mut h = state
        .history
        .lock()
        .map_err(|_| AppError::Internal("history lock poisoned".into()))?;
    h.clear()?;
    Ok(h.list())
}

// ---- export presets (custom ones live in settings) ----------------------------------------

fn validate_preset(mut v: Value) -> Result<Value, AppError> {
    let obj = v
        .as_object_mut()
        .ok_or_else(|| AppError::InvalidInput("preset must be an object".into()))?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::InvalidInput(
            "Give the preset a name (up to 60 characters).".into(),
        ));
    }
    let name = name.to_string();
    obj.insert("name".into(), json!(name));
    if !obj.get("options").is_some_and(Value::is_object) {
        return Err(AppError::InvalidInput("preset has no options".into()));
    }
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    obj.insert("id".into(), json!(id));
    Ok(v)
}

fn save_presets(
    app: &AppHandle,
    st: &AppState,
    f: impl FnOnce(&mut Settings) -> Result<(), AppError>,
) -> Result<Vec<Value>, AppError> {
    let mut s = st.settings();
    f(&mut s)?;
    Ok(super::settings::persist(app, st, s)?.export_presets)
}

#[tauri::command]
pub fn list_export_presets(state: State<'_, AppState>) -> Vec<Value> {
    state.settings().export_presets
}

#[tauri::command]
pub fn save_export_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    preset: Value,
) -> Result<Vec<Value>, AppError> {
    let preset = validate_preset(preset)?;
    save_presets(&app, state.inner(), |s| {
        let id = preset["id"].clone();
        match s.export_presets.iter().position(|p| p["id"] == id) {
            Some(i) => s.export_presets[i] = preset,
            None => s.export_presets.push(preset),
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_export_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<Value>, AppError> {
    save_presets(&app, state.inner(), |s| {
        s.export_presets.retain(|p| p["id"] != json!(id));
        if s.default_preset.as_deref() == Some(id.as_str()) {
            s.default_preset = None;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_validated_and_get_an_id() {
        let p =
            validate_preset(json!({"name": "  Shop  ", "options": {"compression": 9}})).unwrap();
        assert_eq!(p["name"], "Shop");
        assert!(p["id"].as_str().unwrap().len() > 10);
        assert!(validate_preset(json!({"name": "", "options": {}})).is_err());
        assert!(validate_preset(json!({"name": "x"})).is_err());
        assert!(validate_preset(json!("nope")).is_err());
        assert!(validate_preset(json!({"name": "x".repeat(61), "options": {}})).is_err());
    }

    #[test]
    fn an_unsafe_id_is_replaced() {
        let p = validate_preset(json!({"id": "../x", "name": "a", "options": {}})).unwrap();
        assert_ne!(p["id"], "../x");
        let keep = validate_preset(json!({"id": "my-id_1", "name": "a", "options": {}})).unwrap();
        assert_eq!(keep["id"], "my-id_1");
    }

    #[test]
    fn export_needs_items() {
        assert!(validate_items(&[]).is_err());
    }
}
