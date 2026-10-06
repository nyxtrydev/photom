use std::path::PathBuf;

use tauri::State;

use crate::models::dto::{BackgroundImage, ImportResult, WorkingSet};
use crate::models::error::AppError;
use crate::services::{image_io, import, working};
use crate::state::AppState;

#[tauri::command]
pub async fn import_images(
    state: State<'_, AppState>,
    paths: Vec<String>,
    recursive: Option<bool>,
) -> Result<ImportResult, AppError> {
    let st = state.inner().clone();
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tokio::task::spawn_blocking(move || {
        import::import_paths(
            &paths,
            recursive.unwrap_or(false),
            &st.thumbs_dir(),
            &st.images,
            st.pixel_limit(),
        )
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn get_thumbnail(state: State<'_, AppState>, id: String) -> Result<String, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let rec = st.images.get(&id)?;
        let thumb = PathBuf::from(&rec.meta.thumbnail_path);
        if !thumb.is_file() {
            let img = image_io::decode_oriented(&rec.source, st.pixel_limit())?;
            image_io::save_thumbnail(&img, &thumb)?;
        }
        Ok(rec.meta.thumbnail_path)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn prepare_working_set(
    state: State<'_, AppState>,
    id: String,
    max_side: Option<u32>,
) -> Result<WorkingSet, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let rec = st.images.get(&id)?;
        working::prepare(&rec, &st.cache_dir, max_side, st.pixel_limit())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn prepare_background_image(
    state: State<'_, AppState>,
    path: String,
) -> Result<BackgroundImage, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        working::prepare_background(&path, &st.cache_dir, st.pixel_limit())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Show the source file in the OS file manager. Arguments are passed directly (no shell).
#[tauri::command]
pub fn reveal_in_folder(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let rec = state.images.get(&id)?;
    reveal(&rec.source)
}

pub fn reveal(path: &std::path::Path) -> Result<(), AppError> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .status();
    // explorer.exe returns 1 even on success, so only spawn failures are errors.
    status.map(|_| ()).map_err(AppError::from)
}

/// Raw bytes of a file inside the app cache (previews, masks, backgrounds) via binary IPC,
/// so the canvas can read pixels without CORS or tainted-canvas problems.
#[tauri::command]
pub async fn read_cache_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<tauri::ipc::Response, AppError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let bytes = read_inside(&st.cache_dir, &path)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Read a file only if it canonically lives inside `root`.
pub fn read_inside(root: &std::path::Path, path: &str) -> Result<Vec<u8>, AppError> {
    let root = std::fs::canonicalize(root)?;
    let file = std::fs::canonicalize(path)
        .map_err(|_| AppError::InvalidInput(format!("file not found: {path}")))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(AppError::Permission("path is outside the app cache".into()));
    }
    Ok(std::fs::read(file)?)
}

/// Open a folder in the OS file manager.
pub fn open_folder(dir: &std::path::Path) -> Result<(), AppError> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(dir).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(dir).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(dir).status();
    status.map(|_| ()).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_inside_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let inside_file = root.path().join("a.bin");
        let outside_file = outside.path().join("b.bin");
        std::fs::write(&inside_file, b"ok").unwrap();
        std::fs::write(&outside_file, b"no").unwrap();

        assert_eq!(
            read_inside(root.path(), &inside_file.display().to_string()).unwrap(),
            b"ok"
        );
        assert_eq!(
            read_inside(root.path(), &outside_file.display().to_string())
                .unwrap_err()
                .code(),
            "Permission"
        );
        // Traversal out of the root is resolved before the check.
        let sneaky = root
            .path()
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("b.bin");
        assert!(read_inside(root.path(), &sneaky.display().to_string()).is_err());
    }
}
