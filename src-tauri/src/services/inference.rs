use std::path::{Path, PathBuf};
use std::sync::Mutex;

use image::{GrayImage, RgbImage};
#[cfg(any(windows, all(target_os = "macos", target_arch = "aarch64")))]
use ort::ep::ExecutionProvider;
use ort::session::Session;
use ort::value::Tensor;

use super::{postprocess, preprocess};
use crate::infra::model_manager::{self, ModelSpec};
use crate::models::dto::{DevicePref, DeviceUsed, ModelKind};
use crate::models::error::{AppError, AppResult};

struct Loaded {
    session: Session,
    kind: ModelKind,
    pref: DevicePref,
    device: DeviceUsed,
    path: PathBuf,
}

/// Lazily loads one ONNX session and keeps it warm across images.
#[derive(Default)]
pub struct InferenceEngine {
    inner: Mutex<Option<Loaded>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadedInfo {
    pub kind: ModelKind,
    pub device: DeviceUsed,
}

fn ort_err(e: impl std::fmt::Display) -> AppError {
    AppError::Inference(e.to_string())
}

/// Intel macOS builds load ONNX Runtime dynamically (no prebuilt binaries exist).
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn ensure_runtime() {
    if std::env::var_os("ORT_DYLIB_PATH").is_some() {
        return;
    }
    // Packaged app: Contents/Frameworks next to Contents/MacOS. Dev: the copy in src-tauri/vendor.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let candidates = [
        exe_dir.join("../Frameworks/libonnxruntime.1.22.0.dylib"),
        exe_dir.join("../Frameworks/libonnxruntime.dylib"),
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/onnxruntime-osx-x86_64-1.22.0/lib/libonnxruntime.dylib"),
    ];
    if let Some(p) = candidates.iter().find(|p| p.is_file()) {
        std::env::set_var("ORT_DYLIB_PATH", p);
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn ensure_runtime() {}

/// Provider list for the "GPU if available" preference. Empty means CPU only.
fn gpu_providers() -> Vec<ort::ep::ExecutionProviderDispatch> {
    #[cfg(windows)]
    {
        let ep = ort::ep::DirectML::default();
        if ep.is_available().unwrap_or(false) {
            return vec![ep.build()];
        }
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let ep = ort::ep::CoreML::default();
        if ep.is_available().unwrap_or(false) {
            return vec![ep.build()];
        }
    }
    Vec::new()
}

fn load(path: &Path, spec: &ModelSpec, pref: DevicePref) -> AppResult<Loaded> {
    ensure_runtime();
    model_manager::verify(path, spec)?;

    let build = |providers: &[ort::ep::ExecutionProviderDispatch]| -> Result<Session, String> {
        let mut b = Session::builder().map_err(|e| e.to_string())?;
        // Default graph optimisation level (all supported optimisations) is what we want.
        if !providers.is_empty() {
            b = b
                .with_execution_providers(providers)
                .map_err(|e| e.to_string())?;
        }
        b.commit_from_file(path).map_err(|e| e.to_string())
    };

    let mut device = DeviceUsed::Cpu;
    let mut session = None;
    if pref == DevicePref::GpuIfAvailable {
        let providers = gpu_providers();
        if providers.is_empty() {
            tracing::warn!("GPU requested but no provider is available; using CPU");
        } else {
            match build(&providers) {
                Ok(s) => {
                    device = DeviceUsed::Gpu;
                    session = Some(s);
                }
                Err(e) => tracing::warn!("GPU provider failed ({e}); falling back to CPU"),
            }
        }
    }
    let session = match session {
        Some(s) => s,
        None => build(&[]).map_err(AppError::ModelLoad)?,
    };
    tracing::info!(model = %path.display(), ?device, "model session ready");
    Ok(Loaded {
        session,
        kind: spec.kind,
        pref,
        device,
        path: path.to_path_buf(),
    })
}

/// Check that a user-supplied file is a loadable ONNX model with at least one input and output.
pub fn validate_model(path: &Path) -> AppResult<()> {
    ensure_runtime();
    let session = Session::builder()
        .and_then(|mut b| b.commit_from_file(path))
        .map_err(|e| AppError::ModelLoad(e.to_string()))?;
    if session.inputs().is_empty() || session.outputs().is_empty() {
        return Err(AppError::ModelLoad("model has no inputs or outputs".into()));
    }
    Ok(())
}

impl InferenceEngine {
    /// Drop the ONNX session (and its thread pool). Must happen before the process exits: tearing
    /// ONNX Runtime's global state down while its threads are alive aborts the process.
    pub fn unload(&self) {
        if let Ok(mut g) = self.inner.lock() {
            *g = None;
        }
    }

    pub fn loaded_info(&self) -> Option<LoadedInfo> {
        self.inner.lock().ok()?.as_ref().map(|l| LoadedInfo {
            kind: l.kind,
            device: l.device,
        })
    }

    pub fn is_loaded(&self, kind: ModelKind, pref: DevicePref) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|l| l.kind == kind && l.pref == pref))
            .unwrap_or(false)
    }

    /// Run the full pipeline (preprocess, infer, postprocess) and return an alpha mask at the
    /// source resolution plus the device that was actually used.
    pub fn remove_background(
        &self,
        model_path: &Path,
        spec: &ModelSpec,
        pref: DevicePref,
        rgb: &RgbImage,
    ) -> AppResult<(GrayImage, DeviceUsed)> {
        let input = preprocess::preprocess(rgb, spec)?;
        let s = spec.input_size as usize;

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("inference lock poisoned".into()))?;
        let reload = guard
            .as_ref()
            .map(|l| l.kind != spec.kind || l.pref != pref || l.path != model_path)
            .unwrap_or(true);
        if reload {
            *guard = None; // free the old session before loading a new one
            *guard = Some(load(model_path, spec, pref)?);
        }
        let loaded = guard
            .as_mut()
            .ok_or_else(|| AppError::Internal("session missing".into()))?;

        let input_name = loaded
            .session
            .inputs()
            .first()
            .map(|i| i.name().to_string())
            .ok_or_else(|| AppError::Inference("model has no inputs".into()))?;
        let tensor = Tensor::from_array(([1usize, 3, s, s], input)).map_err(ort_err)?;
        let outputs = loaded
            .session
            .run(ort::inputs![input_name.as_str() => tensor])
            .map_err(ort_err)?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(ort_err)?;
        let dims: Vec<i64> = shape.iter().copied().collect();
        let (oh, ow) = match dims.as_slice() {
            [.., h, w] if *h > 0 && *w > 0 => (*h as u32, *w as u32),
            _ => {
                return Err(AppError::Inference(format!(
                    "unexpected output shape {dims:?}"
                )))
            }
        };
        let mask =
            postprocess::to_alpha_mask(data, (ow, oh), (rgb.width(), rgb.height()), spec.sigmoid)?;
        Ok((mask, loaded.device))
    }
}
