use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use super::settings::persist;
use crate::models::error::AppError;
use crate::models::project::{OpenedProject, ProjectMeta, ProjectPayload, RecoveryEntry};
use crate::services::import::ImageRegistry;
use crate::services::project_file::{self, WriteOptions};
use crate::services::settings::{add_recent, RecentProject};
use crate::services::{autosave, image_io};
use crate::state::AppState;

fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Internal(e.to_string())
}

fn project_name_from(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into())
}

/// Validate a user-chosen destination: `.photom` extension, not a directory.
fn destination(raw: &str) -> Result<PathBuf, AppError> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(AppError::InvalidInput(format!(
            "path is not absolute: {raw}"
        )));
    }
    let dest = project_file::normalise_destination(p);
    if dest.is_dir() {
        return Err(AppError::InvalidInput("destination is a folder".into()));
    }
    Ok(dest)
}

/// Copy the first image's thumbnail next to the settings so the Home screen can show it.
fn recent_thumbnail(st: &AppState, dest: &Path, first: Option<&str>) -> Option<String> {
    let rec = st.images.get(first?).ok()?;
    let key = format!(
        "{:x}",
        Sha256::digest(dest.display().to_string().as_bytes())
    );
    let out = st.recent_dir().join(format!("{}.png", &key[..16]));
    std::fs::create_dir_all(st.recent_dir()).ok()?;
    std::fs::copy(&rec.meta.thumbnail_path, &out).ok()?;
    Some(out.display().to_string())
}

fn record_recent(
    app: &AppHandle,
    st: &AppState,
    dest: &Path,
    meta: &ProjectMeta,
    thumb: Option<String>,
) {
    let mut settings = st.settings();
    add_recent(
        &mut settings,
        RecentProject {
            path: dest.display().to_string(),
            name: meta.name.clone(),
            modified: meta.modified.clone(),
            thumbnail: thumb,
        },
    );
    if let Err(e) = persist(app, st, settings) {
        tracing::warn!("could not update recent projects: {e}");
    }
}

/// Add a "project saved" entry to the history (its thumbnail is copied so it outlives the recent list).
fn record_history(st: &AppState, dest: &Path, meta: &ProjectMeta, thumb: Option<&str>) {
    let copied = thumb.and_then(|t| {
        let dir = st.history_dir();
        std::fs::create_dir_all(&dir).ok()?;
        let out = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        std::fs::copy(t, &out).ok()?;
        Some(out.display().to_string())
    });
    if let Ok(mut h) = st.history.lock() {
        let _ = h.add(crate::services::history::HistoryItem::new(
            crate::services::history::HistoryKind::Project,
            &meta.name,
            None,
            Some(dest.display().to_string()),
            copied,
        ));
    }
}

/// Save (or Save As) to `path`. Atomic; keeps one `.bak`.
#[tauri::command]
pub async fn save_project(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProjectPayload,
    path: String,
) -> Result<ProjectMeta, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dest = destination(&path)?;
        let created = project_file::read_manifest(&dest).ok().map(|m| m.created);
        let opts = WriteOptions {
            embed_originals: st.settings().embed_originals,
            keep_backup: true,
        };
        let mut meta = project_file::write_project(
            &payload,
            &st.images,
            &dest,
            opts,
            created,
            Some(&st.cache_dir),
        )?;
        meta.name = payload.name.clone();
        meta.path = Some(dest.display().to_string());
        // A successful manual save supersedes the autosave.
        let _ = autosave::discard(&st.autosave_dir(), &payload.project_id);
        let thumb = recent_thumbnail(&st, &dest, payload.images.first().map(|i| i.id.as_str()));
        record_history(&st, &dest, &meta, thumb.as_deref());
        record_recent(&app, &st, &dest, &meta, thumb);
        tracing::info!(images = payload.images.len(), "project saved");
        Ok(meta)
    })
    .await
    .map_err(join_err)?
}

/// Same operation as `save_project`; kept as a separate command to match the IPC contract.
#[tauri::command]
pub async fn save_project_as(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProjectPayload,
    path: String,
) -> Result<ProjectMeta, AppError> {
    save_project(app, state, payload, path).await
}

fn open_into(st: &AppState, file: &Path) -> Result<OpenedProject, AppError> {
    // Read into a scratch registry first so a corrupt file never destroys the current session.
    let scratch = ImageRegistry::default();
    let opened = project_file::read_project(
        file,
        &scratch,
        &st.projects_dir(),
        &st.masks_dir(),
        &st.thumbs_dir(),
        st.pixel_limit(),
    )?;
    st.images.replace_with(&scratch)?;
    Ok(opened)
}

#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenedProject, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let p = image_io::validate_input_path(&path)?;
        let mut opened = open_into(&st, &p)?;
        opened.meta.path = Some(p.display().to_string());
        let thumb = recent_thumbnail(&st, &p, opened.images.first().map(|i| i.meta.id.as_str()));
        let name = project_name_from(&p);
        opened.meta.name = if opened.meta.name.is_empty() {
            name
        } else {
            opened.meta.name
        };
        record_recent(&app, &st, &p, &opened.meta, thumb);
        tracing::info!(images = opened.images.len(), "project opened");
        Ok(opened)
    })
    .await
    .map_err(join_err)?
}

/// `<path>.bak` if a backup of this project exists (offered when the main file is corrupt).
#[tauri::command]
pub fn project_backup_path(path: String) -> Option<String> {
    let bak = project_file::backup_path(Path::new(&path));
    bak.is_file().then(|| bak.display().to_string())
}

/// Drop every image and cached working file (New project).
#[tauri::command]
pub async fn reset_session(state: State<'_, AppState>) -> Result<(), AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        st.images.clear()?;
        for d in ["thumbs", "masks", "work", "bg", "projects"] {
            let _ = std::fs::remove_dir_all(st.cache_dir.join(d));
        }
        Ok(())
    })
    .await
    .map_err(join_err)?
}

/// Background autosave. Links originals (fast) and never touches the user's own file.
#[tauri::command]
pub async fn autosave_project(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: ProjectPayload,
) -> Result<String, AppError> {
    let st = state.inner().clone();
    let saved = tokio::task::spawn_blocking(move || {
        let dest = autosave::path_for(&st.autosave_dir(), &payload.project_id)?;
        let opts = WriteOptions {
            embed_originals: false,
            keep_backup: false,
        };
        let meta = project_file::write_project(
            &payload,
            &st.images,
            &dest,
            opts,
            None,
            Some(&st.cache_dir),
        )?;
        Ok::<_, AppError>(meta.modified)
    })
    .await
    .map_err(join_err)??;
    let _ = app.emit("autosave:done", &saved);
    Ok(saved)
}

#[tauri::command]
pub fn list_recovery(state: State<'_, AppState>) -> Vec<RecoveryEntry> {
    autosave::list(&state.autosave_dir())
}

#[tauri::command]
pub async fn restore_recovery(
    state: State<'_, AppState>,
    id: String,
) -> Result<OpenedProject, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let file = autosave::path_for(&st.autosave_dir(), &id)?;
        if !file.is_file() {
            return Err(AppError::InvalidInput("recovery file not found".into()));
        }
        let manifest = project_file::read_manifest(&file)?;
        let mut opened = open_into(&st, &file)?;
        // The user's own file is never overwritten implicitly; Save will offer it back.
        opened.meta.path = manifest.original_path;
        Ok(opened)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub fn discard_recovery(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    autosave::discard(&state.autosave_dir(), &id)
}
