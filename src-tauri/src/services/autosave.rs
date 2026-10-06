//! Autosave + crash recovery. Autosaves live in `<appdata>/autosave/<project-id>.photom.tmp`
//! and never touch the user's own project file.

use std::fs;
use std::path::{Path, PathBuf};

use super::project_file;
use crate::models::error::{AppError, AppResult};
use crate::models::project::RecoveryEntry;

const SUFFIX: &str = ".photom.tmp";

fn safe_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::InvalidInput(format!("bad project id: {id}")));
    }
    Ok(())
}

pub fn path_for(dir: &Path, project_id: &str) -> AppResult<PathBuf> {
    safe_id(project_id)?;
    Ok(dir.join(format!("{project_id}{SUFFIX}")))
}

/// Leftover autosaves, newest first. Unreadable files are skipped (and left in place).
pub fn list(dir: &Path) -> Vec<RecoveryEntry> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<RecoveryEntry> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(SUFFIX)?.to_string();
            let m = project_file::read_manifest(&e.path()).ok()?;
            Some(RecoveryEntry {
                id,
                name: m.name,
                saved_at: m.modified,
                original_path: m.original_path,
                image_count: m.images.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    out
}

pub fn discard(dir: &Path, project_id: &str) -> AppResult<()> {
    let p = path_for(dir, project_id)?;
    match fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        let d = Path::new("/tmp");
        assert!(path_for(d, "../etc").is_err());
        assert!(path_for(d, "").is_err());
        assert!(path_for(d, "ok-id_1").is_ok());
    }

    #[test]
    fn discard_is_idempotent_and_list_ignores_junk() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("broken.photom.tmp"), b"junk").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        assert!(list(dir.path()).is_empty());
        discard(dir.path(), "never-existed").unwrap();
        discard(dir.path(), "broken").unwrap();
        assert!(!dir.path().join("broken.photom.tmp").exists());
    }
}
