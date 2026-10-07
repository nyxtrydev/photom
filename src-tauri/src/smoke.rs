//! `photom --smoke-test`: runs the real pipeline inside the real app (import -> remove background
//! -> export -> verify the PNG) and exits 0 on success, 1 on failure. CI runs this against each
//! packaged build to prove the model, the ONNX Runtime library and the file access all work.

use std::path::Path;

use image::{Rgb, RgbImage};
use tauri::{AppHandle, Manager};

use crate::commands::inference::run_removal;
use crate::models::dto::{DevicePref, ModelKind, RemoveOptions};
use crate::models::error::{AppError, AppResult};
use crate::services::exporter::{self, CropOptions, ExportOptions, ItemRequest, ItemState};
use crate::services::import;
use crate::state::AppState;

pub fn requested() -> bool {
    std::env::args().any(|a| a == "--smoke-test")
}

/// A synthetic photo: a bright disc on a gradient. Enough for the model to produce a mask.
fn make_input(dir: &Path) -> AppResult<std::path::PathBuf> {
    let path = dir.join("smoke.png");
    RgbImage::from_fn(640, 480, |x, y| {
        let d = ((x as f32 - 320.0).powi(2) + (y as f32 - 240.0).powi(2)).sqrt();
        if d < 150.0 {
            Rgb([230, 120, 40])
        } else {
            Rgb([40 + (x / 8) as u8, 70, 130 + (y / 8) as u8])
        }
    })
    .save(&path)
    .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(path)
}

pub fn run(app: &AppHandle) -> AppResult<String> {
    let st = app.state::<AppState>().inner().clone();
    let work = std::env::temp_dir().join(format!("photom-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&work)?;
    let result = (|| {
        let input = make_input(&work)?;

        let imported = import::import_paths(
            &[input],
            false,
            &st.thumbs_dir(),
            &st.images,
            st.pixel_limit(),
        )?;
        let meta = imported
            .images
            .first()
            .ok_or_else(|| AppError::Internal("smoke image was not imported".into()))?;

        let model_path = st.require_model(ModelKind::Fast)?;
        let mask = run_removal(
            app,
            &st,
            &meta.id,
            RemoveOptions {
                model: ModelKind::Fast,
                device: DevicePref::Cpu,
            },
        )?;
        if (mask.width, mask.height) != (meta.width, meta.height) {
            return Err(AppError::Inference("mask has the wrong size".into()));
        }

        let out = work.join("out");
        let rec = st.images.get(&meta.id)?;
        let (item, _) = exporter::export_item(&ItemRequest {
            rec: &rec,
            state: &ItemState::default(),
            options: &ExportOptions {
                folder: out.display().to_string(),
                crop: CropOptions {
                    enabled: true,
                    padding: 8,
                },
                ..ExportOptions::default()
            },
            index: 1,
            total: 1,
            date: "smoke",
            pixel_limit: st.pixel_limit(),
        })?;
        let png = image::open(&item.output_path)?;
        if !png.color().has_alpha() || png.width() == 0 {
            return Err(AppError::ExportFailed("exported PNG has no alpha".into()));
        }
        Ok(format!(
            "SMOKE OK model={} mask={}x{} in {} ms, export={}x{} alpha",
            model_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?"),
            mask.width,
            mask.height,
            mask.duration_ms,
            png.width(),
            png.height()
        ))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}
