//! The `.photom` project container (a zip). See docs/PROJECT_FILE_FORMAT.md.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::image_io;
use super::import::{ImageRecord, ImageRegistry};
use crate::models::dto::{DeviceUsed, ImageMeta, MaskResult};
use crate::models::error::{AppError, AppResult};
use crate::models::project::{OpenedImage, OpenedProject, ProjectMeta, ProjectPayload};

pub const FORMAT_VERSION: u32 = 1;
pub const EXTENSION: &str = "photom";
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub app_version: String,
    pub project_id: String,
    pub name: String,
    pub created: String,
    pub modified: String,
    pub original_path: Option<String>,
    pub active_id: Option<String>,
    pub images: Vec<ManifestImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestImage {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// Embedded copy inside the archive. `None` means the project links to `source_path`.
    pub original_file: Option<String>,
    pub source_path: Option<String>,
    pub mask_file: Option<String>,
    pub state_file: String,
    pub thumb_file: Option<String>,
    pub background_file: Option<String>,
}

/// Bring a manifest of any known version up to `FORMAT_VERSION`.
/// - v0 (pre-release): images used `file` instead of `originalFile`, no `projectId`/`created`.
pub fn migrate_manifest(mut v: Value) -> AppResult<Value> {
    let version = v.get("formatVersion").and_then(Value::as_u64).unwrap_or(0) as u32;
    if version > FORMAT_VERSION {
        return Err(AppError::ProjectCorrupt(format!(
            "this project was created by a newer version of Photom (format {version})"
        )));
    }
    if version == 0 {
        let obj = v
            .as_object_mut()
            .ok_or_else(|| AppError::ProjectCorrupt("manifest is not an object".into()))?;
        let modified = obj
            .get("modified")
            .cloned()
            .unwrap_or_else(|| json!(chrono::Utc::now().to_rfc3339()));
        obj.entry("projectId")
            .or_insert_with(|| json!(uuid::Uuid::new_v4().to_string()));
        obj.entry("created").or_insert_with(|| modified.clone());
        obj.entry("modified").or_insert(modified);
        obj.entry("appVersion").or_insert(json!("0.0.0"));
        obj.entry("name").or_insert(json!("Untitled"));
        if let Some(images) = obj.get_mut("images").and_then(Value::as_array_mut) {
            for img in images {
                if let Some(o) = img.as_object_mut() {
                    if let Some(f) = o.remove("file") {
                        o.entry("originalFile").or_insert(f);
                    }
                    let id = o.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                    o.entry("stateFile")
                        .or_insert(json!(format!("images/{id}/state.json")));
                }
            }
        }
        obj.insert("formatVersion".into(), json!(1));
    }
    Ok(v)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn corrupt(msg: impl Into<String>) -> AppError {
    AppError::ProjectCorrupt(msg.into())
}

/// `<path>.bak` for a project file.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".bak");
    PathBuf::from(s)
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "bin".into())
}

/// Ensure the destination ends with `.photom`.
pub fn normalise_destination(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
    {
        path.to_path_buf()
    } else {
        let mut s = path.as_os_str().to_owned();
        s.push(".");
        s.push(EXTENSION);
        PathBuf::from(s)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WriteOptions {
    /// Embed original images (manual saves). Autosaves link instead, to stay fast.
    pub embed_originals: bool,
    /// Keep one `.bak` of the previous file (manual saves).
    pub keep_backup: bool,
}

struct Builder {
    zip: ZipWriter<File>,
    stored: SimpleFileOptions,
    deflated: SimpleFileOptions,
}

impl Builder {
    fn add_bytes(&mut self, name: &str, bytes: &[u8], compress: bool) -> AppResult<()> {
        let opts = if compress { self.deflated } else { self.stored };
        self.zip.start_file(name, opts).map_err(zip_err)?;
        self.zip.write_all(bytes)?;
        Ok(())
    }

    /// Stream a file into the archive without loading it fully into memory.
    fn add_file(&mut self, name: &str, path: &Path) -> AppResult<()> {
        let mut src = File::open(path)?;
        let opts = self
            .stored
            .large_file(src.metadata()?.len() > u32::MAX as u64);
        self.zip.start_file(name, opts).map_err(zip_err)?;
        std::io::copy(&mut src, &mut self.zip)?;
        Ok(())
    }
}

fn zip_err(e: zip::result::ZipError) -> AppError {
    match e {
        zip::result::ZipError::Io(io) => io.into(),
        other => AppError::ProjectCorrupt(other.to_string()),
    }
}

fn temp_sibling(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".into());
    dest.with_file_name(format!(
        ".{name}.{}.tmp",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ))
}

/// Write a project atomically: temp file in the same folder, fsync, optional `.bak`, rename.
pub fn write_project(
    payload: &ProjectPayload,
    registry: &ImageRegistry,
    dest: &Path,
    opts: WriteOptions,
    created: Option<String>,
    managed_dir: Option<&Path>,
) -> AppResult<ProjectMeta> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = temp_sibling(dest);
    let result = build_archive(payload, registry, &tmp, opts, created, managed_dir)
        .and_then(|meta| commit(&tmp, dest, opts.keep_backup).map(|_| meta));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn commit(tmp: &Path, dest: &Path, keep_backup: bool) -> AppResult<()> {
    let bak = backup_path(dest);
    let had_previous = dest.exists();
    if had_previous && keep_backup {
        let _ = fs::remove_file(&bak);
        fs::rename(dest, &bak)?;
    }
    if let Err(e) = fs::rename(tmp, dest) {
        if had_previous && keep_backup {
            let _ = fs::rename(&bak, dest); // put the previous version back
        }
        return Err(e.into());
    }
    Ok(())
}

fn build_archive(
    payload: &ProjectPayload,
    registry: &ImageRegistry,
    tmp: &Path,
    opts: WriteOptions,
    created: Option<String>,
    managed_dir: Option<&Path>,
) -> AppResult<ProjectMeta> {
    let file = File::create(tmp)?;
    let mut b = Builder {
        zip: ZipWriter::new(file),
        stored: SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        deflated: SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    };
    let now = chrono::Utc::now().to_rfc3339();
    let mut images = Vec::new();

    for p in &payload.images {
        if !valid_id(&p.id) {
            return Err(AppError::InvalidInput(format!("bad image id: {}", p.id)));
        }
        let rec = registry.get(&p.id)?;
        let dir = format!("images/{}", p.id);

        // Originals that live inside Photom's own cache (extracted from an earlier project) must
        // be embedded even for autosaves, because the cache is not a stable location.
        let in_cache = managed_dir.is_some_and(|m| rec.source.starts_with(m));
        let embed = opts.embed_originals || in_cache;
        let original_file = if embed {
            let name = format!("{dir}/original.{}", ext_of(&rec.source));
            b.add_file(&name, &rec.source)?;
            Some(name)
        } else {
            None
        };
        let mask_file = match &rec.mask_path {
            Some(m) if m.is_file() => {
                let name = format!("{dir}/mask_model.png");
                b.add_file(&name, m)?;
                Some(name)
            }
            _ => None,
        };
        let thumb = PathBuf::from(&rec.meta.thumbnail_path);
        let thumb_file = if thumb.is_file() {
            let name = format!("thumbs/{}.png", p.id);
            b.add_file(&name, &thumb)?;
            Some(name)
        } else {
            None
        };
        let background_file = match p.background_source.as_deref().map(Path::new) {
            Some(src) if src.is_file() => {
                let name = format!("{dir}/background.{}", ext_of(src));
                b.add_file(&name, src)?;
                Some(name)
            }
            _ => None,
        };
        let state_file = format!("{dir}/state.json");
        let state =
            serde_json::to_vec_pretty(&p.state).map_err(|e| AppError::Internal(e.to_string()))?;
        b.add_bytes(&state_file, &state, true)?;

        images.push(ManifestImage {
            id: rec.meta.id.clone(),
            name: rec.meta.name.clone(),
            width: rec.meta.width,
            height: rec.meta.height,
            format: rec.meta.format.clone(),
            original_file,
            source_path: (!embed).then(|| rec.source.display().to_string()),
            mask_file,
            state_file,
            thumb_file,
            background_file,
        });
    }

    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        project_id: payload.project_id.clone(),
        name: payload.name.clone(),
        created: created.unwrap_or_else(|| now.clone()),
        modified: now.clone(),
        original_path: payload.original_path.clone(),
        active_id: payload.active_id.clone(),
        images,
    };
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|e| AppError::Internal(e.to_string()))?;
    b.add_bytes("manifest.json", &bytes, true)?;
    let file = b.zip.finish().map_err(zip_err)?;
    file.sync_all()?;

    Ok(ProjectMeta {
        project_id: manifest.project_id,
        name: manifest.name,
        path: None,
        modified: now,
        format_version: FORMAT_VERSION,
        active_id: manifest.active_id,
    })
}

fn open_archive(path: &Path) -> AppResult<ZipArchive<File>> {
    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::InvalidInput(format!("file not found: {}", path.display()))
        }
        _ => e.into(),
    })?;
    ZipArchive::new(file).map_err(|e| corrupt(format!("not a valid project archive ({e})")))
}

fn read_entry(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> AppResult<Vec<u8>> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| corrupt(format!("missing {name}")))?;
    if entry.size() > limit {
        return Err(corrupt(format!("{name} is too large")));
    }
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| corrupt(format!("{name} is unreadable ({e})")))?;
    Ok(buf)
}

fn extract_entry(archive: &mut ZipArchive<File>, name: &str, dest: &Path) -> AppResult<()> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| corrupt(format!("missing {name}")))?;
    if entry.size() > MAX_ENTRY_BYTES {
        return Err(corrupt(format!("{name} is too large")));
    }
    if let Some(p) = dest.parent() {
        fs::create_dir_all(p)?;
    }
    let mut out = File::create(dest)?;
    std::io::copy(&mut entry.by_ref().take(MAX_ENTRY_BYTES), &mut out)
        .map_err(|e| corrupt(format!("{name} is unreadable ({e})")))?;
    Ok(())
}

/// Read only the manifest (used to list recovery entries and for fast validation).
pub fn read_manifest(path: &Path) -> AppResult<Manifest> {
    let mut archive = open_archive(path)?;
    let raw = read_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES)?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|e| corrupt(format!("manifest is not valid JSON ({e})")))?;
    serde_json::from_value(migrate_manifest(value)?)
        .map_err(|e| corrupt(format!("manifest is invalid ({e})")))
}

/// Open a project: validate, extract into `work_dir`, register images and return their state.
pub fn read_project(
    path: &Path,
    registry: &ImageRegistry,
    work_dir: &Path,
    masks_dir: &Path,
    thumbs_dir: &Path,
    pixel_limit: u64,
) -> AppResult<OpenedProject> {
    let manifest = read_manifest(path)?;
    let mut archive = open_archive(path)?;
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    let mut warnings = Vec::new();
    let project_dir = work_dir.join(&manifest.project_id);
    if !valid_id(&manifest.project_id) {
        return Err(corrupt("project id is invalid"));
    }

    for mi in &manifest.images {
        if !valid_id(&mi.id) || !seen.insert(mi.id.clone()) {
            return Err(corrupt(format!("bad or duplicate image id: {}", mi.id)));
        }
        // Source: embedded copy (extracted) or a linked file that must still exist.
        let source = match (&mi.original_file, &mi.source_path) {
            (Some(entry), _) => {
                let dest = project_dir
                    .join("images")
                    .join(&mi.id)
                    .join(format!("original.{}", ext_of(Path::new(entry))));
                extract_entry(&mut archive, entry, &dest)?;
                dest
            }
            (None, Some(src)) if Path::new(src).is_file() => PathBuf::from(src),
            (None, Some(src)) => {
                warnings.push(format!("{}: the original file is missing ({src})", mi.name));
                continue;
            }
            (None, None) => return Err(corrupt(format!("{} has no source", mi.name))),
        };
        let (width, height, format) = image_io::read_header(&source, pixel_limit)
            .map_err(|e| corrupt(format!("{} cannot be read ({e})", mi.name)))?;

        let thumb_path = thumbs_dir.join(format!("{}.png", mi.id));
        let thumb_ok = mi
            .thumb_file
            .as_deref()
            .map(|t| extract_entry(&mut archive, t, &thumb_path).is_ok())
            .unwrap_or(false);
        if !thumb_ok {
            let img = image_io::decode_oriented(&source, pixel_limit)?;
            image_io::save_thumbnail(&img, &thumb_path)?;
        }

        let mask_path = match &mi.mask_file {
            Some(entry) => {
                let run = &uuid::Uuid::new_v4().simple().to_string()[..8];
                let dest = masks_dir.join(format!("{}-{run}.png", mi.id));
                extract_entry(&mut archive, entry, &dest)?;
                Some(dest)
            }
            None => None,
        };

        let raw_state = read_entry(&mut archive, &mi.state_file, MAX_MANIFEST_BYTES)?;
        let mut state: Value = serde_json::from_slice(&raw_state)
            .map_err(|e| corrupt(format!("state of {} is invalid ({e})", mi.name)))?;

        // Re-create the background picture's cache copy and point the state at it.
        if let Some(entry) = &mi.background_file {
            let dest = project_dir
                .join("images")
                .join(&mi.id)
                .join(format!("background.{}", ext_of(Path::new(entry))));
            extract_entry(&mut archive, entry, &dest)?;
            if let Some(cache_dir) = work_dir.parent() {
                match super::working::prepare_background(
                    &dest.display().to_string(),
                    cache_dir,
                    pixel_limit,
                ) {
                    Ok(bg) => {
                        if let Some(slot) = state.pointer_mut("/background") {
                            slot["image"] = serde_json::to_value(&bg)
                                .map_err(|e| AppError::Internal(e.to_string()))?;
                        }
                    }
                    Err(e) => warnings.push(format!("{}: background image: {e}", mi.name)),
                }
            }
        }

        let meta = ImageMeta {
            id: mi.id.clone(),
            path: source.display().to_string(),
            name: mi.name.clone(),
            width,
            height,
            format: image_io::format_name(format),
            thumbnail_path: thumb_path.display().to_string(),
        };
        let mask = match &mask_path {
            Some(p) => {
                let gray = image::open(p)
                    .map_err(|e| corrupt(format!("mask of {} is unreadable ({e})", mi.name)))?
                    .to_luma8();
                Some(MaskResult {
                    id: mi.id.clone(),
                    mask_path: p.display().to_string(),
                    width: gray.width(),
                    height: gray.height(),
                    bounding_box: image_io::mask_bounding_box(&gray, 10),
                    duration_ms: 0,
                    device: DeviceUsed::Cpu,
                })
            }
            None => None,
        };
        registry.insert(ImageRecord {
            meta: meta.clone(),
            source,
            mask_path,
        })?;
        images.push(OpenedImage { meta, state, mask });
    }

    Ok(OpenedProject {
        meta: ProjectMeta {
            project_id: manifest.project_id,
            name: manifest.name,
            path: None,
            modified: manifest.modified,
            format_version: manifest.format_version,
            active_id: manifest.active_id,
        },
        images,
        warnings,
    })
}

#[cfg(test)]
#[path = "project_file_tests.rs"]
mod tests;
