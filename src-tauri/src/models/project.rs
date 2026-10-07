use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::dto::{ImageMeta, MaskResult};

/// What the frontend sends to save a project. Image metadata, paths and masks come from the
/// backend registry; only editor state travels over IPC.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPayload {
    pub project_id: String,
    pub name: String,
    pub active_id: Option<String>,
    /// Where the user saved this project (recorded in autosaves so recovery can offer it back).
    pub original_path: Option<String>,
    pub images: Vec<ProjectImagePayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImagePayload {
    pub id: String,
    /// Opaque editor state (refine, background, output, strokes, ...), stored as state.json.
    pub state: Value,
    /// Source file of a background picture to embed, if the background is an image.
    pub background_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub project_id: String,
    pub name: String,
    pub path: Option<String>,
    pub modified: String,
    pub format_version: u32,
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedImage {
    pub meta: ImageMeta,
    pub state: Value,
    pub mask: Option<MaskResult>,
    /// The kept upscaled version, if the project has one.
    pub upscaled: Option<crate::services::upscale::KeptUpscale>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub meta: ProjectMeta,
    pub images: Vec<OpenedImage>,
    /// Non-fatal problems, e.g. a linked original that no longer exists.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub id: String,
    pub name: String,
    pub saved_at: String,
    pub original_path: Option<String>,
    pub image_count: usize,
}
