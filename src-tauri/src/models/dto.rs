use serde::{Deserialize, Serialize};

/// Mirrored by `src/types/dto.ts`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub message: String,
    pub app_version: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub id: String,
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub thumbnail_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RejectedFile {
    pub path: String,
    pub reason: String,
}

/// Result of `import_images`: accepted images plus per-file rejections (never an all-or-nothing failure).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub images: Vec<ImageMeta>,
    pub rejected: Vec<RejectedFile>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ModelKind {
    Fast,
    Quality,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DevicePref {
    Cpu,
    GpuIfAvailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceUsed {
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOptions {
    pub model: ModelKind,
    pub device: DevicePref,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoundingBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskResult {
    pub id: String,
    pub mask_path: String,
    pub width: u32,
    pub height: u32,
    pub bounding_box: Option<BoundingBox>,
    pub duration_ms: u64,
    pub device: DeviceUsed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelState {
    Missing,
    Idle,
    Loading,
    Loaded,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    /// Model file is present (it may not be loaded into memory yet).
    pub ready: bool,
    pub state: ModelState,
    pub active_model: ModelKind,
    pub device: DeviceUsed,
    pub path: Option<String>,
    pub message: Option<String>,
}

/// Downscaled copies of an image (and its mask) used for interactive editing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingSet {
    pub id: String,
    pub preview_path: String,
    /// Raw model mask resized to the working size; `None` until background removal has run.
    pub mask_path: Option<String>,
    pub work_width: u32,
    pub work_height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImage {
    /// Downscaled copy in the app cache (safe to display via the asset protocol).
    pub cache_path: String,
    pub source_path: String,
    pub width: u32,
    pub height: u32,
}
