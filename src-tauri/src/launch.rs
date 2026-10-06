//! Opening `.photom` files from the operating system (double-click, "Open with", a second launch).

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub const OPEN_FILE_EVENT: &str = "app:open-file";

/// First argument that names an existing `.photom` file (flags and other arguments are ignored).
pub fn project_from_args<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .map(|a| PathBuf::from(a.as_ref()))
        .find(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("photom"))
                && p.is_file()
        })
}

/// Hand a project to the app: as an event if the UI is listening, otherwise stored until it asks.
pub fn deliver(app: &AppHandle, path: &std::path::Path) {
    let Some(st) = app.try_state::<AppState>() else {
        return;
    };
    let ready = st.frontend_ready.load(Ordering::SeqCst);
    tracing::info!(file = %path.display(), ui_ready = ready, "open-file delivered");
    if ready {
        let _ = app.emit(OPEN_FILE_EVENT, path.display().to_string());
    } else if let Ok(mut slot) = st.launch_file.lock() {
        *slot = Some(path.to_path_buf());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_project_among_other_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("My Project é.photom");
        std::fs::write(&p, b"x").unwrap();
        let other = dir.path().join("notes.txt");
        std::fs::write(&other, b"x").unwrap();
        let args = vec![
            "photom".to_string(),
            "--smoke-test".to_string(),
            other.display().to_string(),
            p.display().to_string(),
        ];
        assert_eq!(project_from_args(args), Some(p));
    }

    #[test]
    fn ignores_missing_files_and_other_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        std::fs::write(&png, b"x").unwrap();
        let missing = dir.path().join("gone.photom");
        assert_eq!(
            project_from_args([png.display().to_string(), missing.display().to_string()]),
            None
        );
        assert_eq!(project_from_args(Vec::<String>::new()), None);
    }

    #[test]
    fn extension_match_is_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("A.PHOTOM");
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(project_from_args([p.display().to_string()]), Some(p));
    }
}

/// The frontend calls this once at startup to get a project that launched the app, and from then
/// on receives `app:open-file` events.
#[tauri::command]
pub fn take_launch_file(state: tauri::State<'_, AppState>) -> Option<String> {
    state.frontend_ready.store(true, Ordering::SeqCst);
    state
        .launch_file
        .lock()
        .ok()
        .and_then(|mut f| f.take())
        .map(|p| p.display().to_string())
}
