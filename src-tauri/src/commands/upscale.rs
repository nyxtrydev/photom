//! Upscale commands. `upscale_run` is a job (progress and cancel come from the job queue); the
//! result waits in the store until `upscale_accept` (Keep) or `upscale_discard`.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};

use super::export::TauriEvents;
use crate::model_hub::hub::Requirement;
use crate::models::dto::DevicePref;
use crate::models::error::{AppError, AppResult};
use crate::services::history::{HistoryItem, HistoryKind};
use crate::services::upscale::{
    self, Engine, Estimate, KeptUpscale, PendingResult, UpscaleParams, UpscaleStore,
};
use crate::services::{image_io, import::ImageRecord, inference, upscale_ai};
use crate::state::AppState;

fn model_id(scale: u32) -> AppResult<&'static str> {
    match scale {
        2 => Ok("upscale-x2"),
        4 => Ok("upscale-x4"),
        s => Err(AppError::InvalidInput(format!(
            "Choose 2x or 4x (got {s}x)."
        ))),
    }
}

/// The largest result allowed, in megapixels (the "largest upscaled result" setting).
fn cap_mp(st: &AppState) -> u32 {
    st.settings().upscale_max_mp
}

/// Output size, time and memory for a request, with warnings. Never decodes the image.
#[tauri::command]
pub fn upscale_estimate(
    state: State<'_, AppState>,
    image_id: String,
    params: UpscaleParams,
) -> Result<Estimate, AppError> {
    let rec = state.images.get(&image_id)?;
    upscale::estimate((rec.meta.width, rec.meta.height), &params, cap_mp(&state))
}

/// Which models a scale needs (Model Hub).
#[tauri::command]
pub fn upscale_requirements(
    state: State<'_, AppState>,
    scale: u32,
) -> Result<Requirement, AppError> {
    Ok(state.hub.check_models(&[model_id(scale)?.to_string()]))
}

/// Tiled AI upscale through the Model Hub's warm session for the scale the request needs.
fn run_ai(
    st: &AppState,
    rec: &ImageRecord,
    src: &image::RgbaImage,
    out: (u32, u32),
) -> AppResult<image::RgbaImage> {
    let scale = upscale::model_scale(src.dimensions(), out);
    upscale_ai::check_memory(
        upscale_ai::memory_mb(src.dimensions(), out, scale),
        upscale_ai::available_memory_mb(),
    )?;
    let id = model_id(scale)?;
    // Settings > Model: GPU when asked for and available; open_session falls back to the CPU.
    let pref = st.settings().processing;
    let variant = if pref == DevicePref::GpuIfAvailable {
        "gpu"
    } else {
        "cpu"
    };
    let session = st.sessions.get(&st.hub, id, variant, |p| {
        inference::open_session(p, pref).map(|(s, _)| s)
    })?;
    let image_id = rec.meta.id.clone();
    let cancelled = || st.upscale.is_cancelled(&image_id);
    let progress = |done: u32, total: u32| {
        st.hub.emit(
            "upscale:progress",
            serde_json::json!({ "id": image_id, "done": done, "total": total }),
        );
    };
    let hooks = upscale_ai::TileHooks {
        cancelled: &cancelled,
        progress: &progress,
    };
    let mut guard = session
        .lock()
        .map_err(|_| AppError::Internal("model session lock poisoned".into()))?;
    let mut model = |t: &[f32]| upscale_ai::run_session(&mut guard, t);
    upscale_ai::upscale_ai(src, out, scale, &mut model, &hooks)
}

fn run_one(st: &AppState, rec: &ImageRecord, params: &UpscaleParams) -> AppResult<PendingResult> {
    let src_dims = (rec.meta.width, rec.meta.height);
    let out = upscale::check_allowed(src_dims, params, cap_mp(st))?;
    let src = image_io::decode_oriented(&rec.source, st.pixel_limit())?.to_rgba8();
    // The decoded size is the truth (EXIF orientation may have swapped the header's dimensions).
    let out = if src.dimensions() == src_dims {
        out
    } else {
        upscale::check_allowed(src.dimensions(), params, cap_mp(st))?
    };
    let src = if params.pre_denoise {
        upscale::denoise_light(&src)
    } else {
        src
    };
    let big = if params.engine == Engine::Ai {
        run_ai(st, rec, &src, out)?
    } else {
        upscale::upscale_standard(&src, out)?
    };
    drop(src);
    let path = UpscaleStore::dir(&st.cache_dir, &rec.meta.id).join(format!(
        "pending-{}.png",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    upscale::save_png(&big, &path)?;
    Ok(PendingResult {
        id: rec.meta.id.clone(),
        path: path.display().to_string(),
        width: big.width(),
        height: big.height(),
        scale: params.scale.filter(|_| params.target.is_none()),
        engine: params.engine,
    })
}

/// Start an upscale as a background job. The result is announced by `job:item-complete`.
#[tauri::command]
pub fn upscale_run(
    app: AppHandle,
    state: State<'_, AppState>,
    image_id: String,
    params: UpscaleParams,
) -> Result<String, AppError> {
    let st = state.inner().clone();
    let rec = st.images.get(&image_id)?;
    st.upscale.clear_cancel(&image_id);
    // Fail fast on a request that can never run, instead of failing inside the job.
    upscale::check_allowed((rec.meta.width, rec.meta.height), &params, cap_mp(&st))?;
    let events = Arc::new(TauriEvents { app });
    let labels = vec![(image_id.clone(), rec.meta.name.clone())];
    let st2 = st.clone();
    Ok(st.jobs.start("upscale", labels, 1, events, move |_, id| {
        let rec = st2.images.get(id)?;
        let pending = run_one(&st2, &rec, &params)?;
        st2.upscale.set_pending(pending.clone())?;
        serde_json::to_value(pending).map_err(|e| AppError::Internal(e.to_string()))
    }))
}

/// The most images one batch may carry.
const MAX_BATCH: usize = 500;

/// Upscale many images with the same scale and keep every result (a failure only fails its own
/// image). Each finished image reports `{id, kept}`; per-image review afterwards is optional
/// ("Back to the original" in the Upscale tab undoes one).
#[tauri::command]
pub fn upscale_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    image_ids: Vec<String>,
    params: UpscaleParams,
) -> Result<String, AppError> {
    let st = state.inner().clone();
    if image_ids.is_empty() || image_ids.len() > MAX_BATCH {
        return Err(AppError::InvalidInput(format!(
            "Choose between 1 and {MAX_BATCH} images."
        )));
    }
    let Some(scale) = params.scale.filter(|_| params.target.is_none()) else {
        return Err(AppError::InvalidInput(
            "A batch upscales by 2x or 4x; a target size applies to one image.".into(),
        ));
    };
    if params.engine == Engine::Ai {
        let id = model_id(scale)?;
        if !st.hub.is_ready(id) {
            return Err(AppError::ModelMissing(id.to_string()));
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut labels = Vec::new();
    for id in image_ids.iter().filter(|i| seen.insert((*i).clone())) {
        let rec = st.images.get(id)?;
        labels.push((id.clone(), rec.meta.name));
    }
    let events = Arc::new(TauriEvents { app });
    let st2 = st.clone();
    Ok(st
        .jobs
        .start("upscaleBatch", labels, 1, events, move |_, id| {
            batch_one(&st2, id, &params)
        }))
}

/// One image of a batch: upscale, keep, and note it in History.
fn batch_one(st: &AppState, id: &str, params: &UpscaleParams) -> AppResult<serde_json::Value> {
    let rec = st.images.get(id)?;
    st.upscale.clear_cancel(id);
    let pending = run_one(st, &rec, params)?;
    st.upscale.set_pending(pending)?;
    let kept = upscale::keep(&st.images, &st.upscale, &st.cache_dir, id)?;
    if let Ok(mut h) = st.history.lock() {
        let _ = h.add(HistoryItem::new(
            HistoryKind::Upscale,
            &format!(
                "{} upscaled to {} x {}",
                rec.meta.name, kept.width, kept.height
            ),
            Some(rec.source.display().to_string()),
            None,
            None,
        ));
    }
    Ok(serde_json::json!({ "id": id, "kept": kept }))
}

/// Stop a running AI upscale at the next tile boundary.
#[tauri::command]
pub fn upscale_cancel(state: State<'_, AppState>, image_id: String) -> Result<(), AppError> {
    state.upscale.request_cancel(&image_id);
    Ok(())
}

/// Keep the waiting result: it becomes the image's upscaled version (saved with the project).
#[tauri::command]
pub fn upscale_accept(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<KeptUpscale, AppError> {
    let rec = state.images.get(&image_id)?;
    let kept = upscale::keep(&state.images, &state.upscale, &state.cache_dir, &image_id)?;
    if let Ok(mut h) = state.history.lock() {
        let _ = h.add(HistoryItem::new(
            HistoryKind::Upscale,
            &format!(
                "{} upscaled to {} x {}",
                rec.meta.name, kept.width, kept.height
            ),
            Some(rec.source.display().to_string()),
            None,
            None,
        ));
    }
    Ok(kept)
}

/// Throw away the waiting result; with `include_kept` also the kept upscaled version, so the image
/// is back to its original.
#[tauri::command]
pub fn upscale_discard(
    state: State<'_, AppState>,
    image_id: String,
    include_kept: Option<bool>,
) -> Result<(), AppError> {
    state.images.get(&image_id)?;
    upscale::discard(
        &state.images,
        &state.upscale,
        &image_id,
        include_kept.unwrap_or(false),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoupeRequest {
    pub x: u32,
    pub y: u32,
    pub size: u32,
}

/// A 100 % detail crop of the waiting result with the matching enlarged original beside it, as a
/// PNG (`size * 2` wide). Coordinates are in result pixels.
#[tauri::command]
pub async fn upscale_loupe(
    state: State<'_, AppState>,
    image_id: String,
    at: LoupeRequest,
) -> Result<tauri::ipc::Response, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let rec = st.images.get(&image_id)?;
        let pending = st.upscale.pending(&image_id)?.ok_or_else(|| {
            AppError::InvalidInput("There is no upscaled result to look at.".into())
        })?;
        let result = image::open(&pending.path)?.to_rgba8();
        let original = image_io::decode_oriented(&rec.source, st.pixel_limit())?.to_rgba8();
        let crop = upscale::loupe_crop(&original, &result, at.x, at.y, at.size)?;
        let mut bytes = Vec::new();
        crop.write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_map_to_their_models() {
        assert_eq!(model_id(2).unwrap(), "upscale-x2");
        assert_eq!(model_id(4).unwrap(), "upscale-x4");
        assert!(model_id(3).is_err());
    }

    fn test_state(dir: &std::path::Path) -> AppState {
        use crate::infra::model_manager::ModelManager;
        use crate::model_hub::{downloader::NetConfig, installer::Installer, ModelHub};
        let models = ModelManager::new(None, None);
        let hub = Arc::new(ModelHub::new(
            dir.join("models"),
            models.clone(),
            Arc::new(|_, _| {}),
        ));
        let installer = Installer::new(
            hub.clone(),
            NetConfig::default(),
            tokio::runtime::Handle::current(),
        )
        .unwrap();
        let cache_dir = dir.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        AppState {
            images: Default::default(),
            engine: Arc::new(Default::default()),
            models,
            hub,
            installer,
            sessions: Arc::new(Default::default()),
            settings: Arc::new(std::sync::RwLock::new(Default::default())),
            jobs: Arc::new(Default::default()),
            history: Arc::new(std::sync::Mutex::new(
                crate::services::history::HistoryStore::load(dir.join("history.json")),
            )),
            upscale: Default::default(),
            pending_update: Default::default(),
            launch_file: Arc::new(std::sync::Mutex::new(None)),
            frontend_ready: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cache_dir,
            data_dir: dir.to_path_buf(),
        }
    }

    fn add_image(st: &AppState, dir: &std::path::Path, id: &str, w: u32, h: u32, ok: bool) {
        let path = dir.join(format!("{id}.png"));
        if ok {
            image::RgbaImage::from_fn(w, h, |x, y| {
                image::Rgba([(x * 5) as u8, (y * 5) as u8, 90, 255])
            })
            .save(&path)
            .unwrap();
        } else {
            std::fs::write(&path, b"not an image").unwrap();
        }
        st.images
            .insert(ImageRecord {
                meta: crate::models::dto::ImageMeta {
                    id: id.into(),
                    path: path.display().to_string(),
                    name: format!("{id}.png"),
                    width: w,
                    height: h,
                    format: "png".into(),
                    thumbnail_path: String::new(),
                },
                source: path,
                mask_path: None,
            })
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_batch_keeps_each_result_and_a_bad_image_only_fails_itself() {
        let dir = tempfile::tempdir().unwrap();
        let st = test_state(dir.path());
        add_image(&st, dir.path(), "a", 30, 20, true);
        add_image(&st, dir.path(), "bad", 30, 20, false);
        add_image(&st, dir.path(), "c", 16, 16, true);
        let params = UpscaleParams {
            scale: Some(2),
            ..UpscaleParams::default()
        };
        let a = batch_one(&st, "a", &params).unwrap();
        assert_eq!(a["id"], "a");
        assert_eq!(a["kept"]["width"], 60);
        assert!(batch_one(&st, "bad", &params).is_err());
        let c = batch_one(&st, "c", &params).unwrap();
        assert_eq!(c["kept"]["height"], 32);
        // Kept results are registered; the failed image has none.
        assert_eq!(st.images.upscaled("a").unwrap().unwrap().width, 60);
        assert!(st.images.upscaled("bad").unwrap().is_none());
        assert_eq!(st.history.lock().unwrap().list().len(), 2);
    }

    /// The AI engine end to end with the model that ships in the app: hub -> session -> tiles.
    #[tokio::test(flavor = "multi_thread")]
    async fn ai_upscaling_runs_with_the_bundled_model_and_honours_the_size_cap() {
        let dir = tempfile::tempdir().unwrap();
        let st = test_state(dir.path());
        if !st.hub.is_ready("upscale-x2") {
            eprintln!("upscale-x2 is not bundled here; skipping");
            return;
        }
        add_image(&st, dir.path(), "a", 40, 30, true);
        let ai = UpscaleParams {
            scale: Some(2),
            engine: Engine::Ai,
            ..UpscaleParams::default()
        };
        let out = batch_one(&st, "a", &ai).unwrap();
        assert_eq!(
            (
                out["kept"]["width"].as_u64(),
                out["kept"]["height"].as_u64()
            ),
            (Some(80), Some(60))
        );
        assert_eq!(out["kept"]["engine"], "ai");
        let kept = image::open(out["kept"]["path"].as_str().unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(kept.dimensions(), (80, 60));
        // A cap below the result size blocks it.
        st.settings.write().unwrap().upscale_max_mp = 1;
        add_image(&st, dir.path(), "big", 800, 700, true);
        let four = UpscaleParams {
            scale: Some(4),
            ..ai
        };
        let err = batch_one(&st, "big", &four).unwrap_err();
        assert!(err.to_string().contains("limit"), "{err}");
    }
}
