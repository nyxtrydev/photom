use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use crate::infra::model_manager;
use crate::models::dto::{
    DeviceUsed, MaskResult, ModelKind, ModelState, ModelStatus, RemoveOptions,
};
use crate::models::error::AppError;
use crate::services::image_io;
use crate::state::AppState;

fn status(
    st: &AppState,
    kind: ModelKind,
    state: Option<ModelState>,
    message: Option<String>,
) -> ModelStatus {
    let path = st.locate_model(kind);
    let loaded = st.engine.loaded_info();
    let active = loaded.filter(|l| l.kind == kind);
    let state = state.unwrap_or(if path.is_none() {
        ModelState::Missing
    } else if active.is_some() {
        ModelState::Loaded
    } else {
        ModelState::Idle
    });
    ModelStatus {
        ready: path.is_some(),
        state,
        active_model: kind,
        device: active.map(|l| l.device).unwrap_or(DeviceUsed::Cpu),
        path: path.map(|p| p.display().to_string()),
        message,
    }
}

#[tauri::command]
pub fn get_model_status(state: State<'_, AppState>, model: Option<ModelKind>) -> ModelStatus {
    status(state.inner(), model.unwrap_or(ModelKind::Fast), None, None)
}

/// Run background removal for one image (shared by the single and batch commands).
/// Emits `model:status` while the model loads and when the run ends.
pub fn run_removal(
    app: &AppHandle,
    st: &AppState,
    id: &str,
    options: RemoveOptions,
) -> Result<MaskResult, AppError> {
    let RemoveOptions { model, device } = options;
    let started = Instant::now();
    let rec = st.images.get(id)?;
    let model_path = st.require_model(model)?;
    let spec = model_manager::spec(model);

    if !st.engine.is_loaded(model, device) {
        let _ = app.emit(
            "model:status",
            status(st, model, Some(ModelState::Loading), None),
        );
    }

    let run = || -> Result<MaskResult, AppError> {
        let img = image_io::decode_oriented(&rec.source, st.pixel_limit())?;
        let rgb = image_io::to_rgb_for_inference(&img);
        drop(img);
        let (mask, used) = st
            .engine
            .remove_background(&model_path, &spec, device, &rgb)?;
        // One file per run so a re-run can be undone by switching back to the previous mask.
        let run = uuid::Uuid::new_v4().simple().to_string();
        let mask_path = st.masks_dir().join(format!("{id}-{}.png", &run[..8]));
        image_io::save_mask(&mask, &mask_path)?;
        st.images.set_mask(id, Some(mask_path.clone()))?;
        Ok(MaskResult {
            id: id.to_string(),
            mask_path: mask_path.display().to_string(),
            width: mask.width(),
            height: mask.height(),
            bounding_box: image_io::mask_bounding_box(&mask, 10),
            duration_ms: started.elapsed().as_millis() as u64,
            device: used,
        })
    };

    let result = run();
    let msg = result.as_ref().err().map(|e| e.to_string());
    let state = result.as_ref().err().map(|_| ModelState::Error);
    let _ = app.emit("model:status", status(st, model, state, msg));
    result
}

#[tauri::command]
pub async fn remove_background(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    options: RemoveOptions,
) -> Result<MaskResult, AppError> {
    let st = state.inner().clone();
    let outcome = tokio::task::spawn_blocking(move || run_removal(&app, &st, &id, options))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    tracing::info!(ok = outcome.is_ok(), "remove_background finished");
    outcome
}

/// Switch an image back to a mask produced by an earlier run (undo/redo of a re-run).
/// The path must live inside the app's mask cache.
#[tauri::command]
pub fn set_active_mask(
    state: State<'_, AppState>,
    id: String,
    mask_path: Option<String>,
) -> Result<(), AppError> {
    state.images.get(&id)?; // validates the id
    let Some(mask_path) = mask_path else {
        return state.images.set_mask(&id, None); // undo of a first run
    };
    let dir = std::fs::canonicalize(state.masks_dir())?;
    let path = std::fs::canonicalize(&mask_path)
        .map_err(|_| AppError::InvalidInput(format!("mask not found: {mask_path}")))?;
    if !path.starts_with(&dir) || !path.is_file() {
        return Err(AppError::InvalidInput(
            "mask is outside the mask cache".into(),
        ));
    }
    state.images.set_mask(&id, Some(path))
}
