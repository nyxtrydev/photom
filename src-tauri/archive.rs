//! Safe zip extraction for multi-file models. Models are data only; nothing is executed.

use std::io::{Read, Write};
use std::path::Path;

use super::manifest::is_safe_relative_path;
use crate::models::error::{AppError, AppResult};

const MAX_ENTRIES: usize = 1024;

/// Extract `archive` into `dest`. Rejects absolute paths, `..`, symlinks, too many entries and
/// more than `max_total` uncompressed bytes (counted while reading, not from the headers).
pub fn extract_zip(archive: &Path, dest: &Path, max_total: u64) -> AppResult<()> {
    let bad = |m: String| AppError::HashMismatch(format!("unsafe archive: {m}"));
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)
        .map_err(|e| bad(format!("unreadable ({e})")))?;
    if zip.len() > MAX_ENTRIES {
        return Err(bad("too many entries".into()));
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| bad(e.to_string()))?;
        let name = entry.name().to_string();
        if !is_safe_relative_path(name.trim_end_matches('/')) {
            return Err(bad(format!("entry '{name}'")));
        }
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(bad(format!("symlink '{name}'")));
        }
        let out = dest.join(name.trim_end_matches('/'));
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&out)?;
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = entry.read(&mut buf)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > max_total {
                return Err(bad("expands beyond the size limit".into()));
            }
            file.write_all(&buf[..n])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn make(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, std::path::PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        for (n, b) in entries {
            w.start_file(*n, SimpleFileOptions::default()).unwrap();
            w.write_all(b).unwrap();
        }
        w.finish().unwrap();
        (d, p)
    }

    #[test]
    fn extracts_nested_files() {
        let (_d, p) = make(&[("model.onnx", b"m"), ("sub/w.bin", b"w")]);
        let out = tempfile::tempdir().unwrap();
        extract_zip(&p, out.path(), 100).unwrap();
        assert_eq!(std::fs::read(out.path().join("sub/w.bin")).unwrap(), b"w");
    }

    #[test]
    fn rejects_traversal_and_absolute_entries() {
        for name in ["../evil", "a/../../evil", "/abs"] {
            let (_d, p) = make(&[(name, b"x")]);
            let out = tempfile::tempdir().unwrap();
            assert!(extract_zip(&p, out.path(), 100).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        w.add_symlink("link", "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        w.finish().unwrap();
        let out = tempfile::tempdir().unwrap();
        assert!(extract_zip(&p, out.path(), 100).is_err());
    }

    #[test]
    fn enforces_the_expansion_limit() {
        let (_d, p) = make(&[("model.onnx", &[0u8; 500])]);
        let out = tempfile::tempdir().unwrap();
        assert!(extract_zip(&p, out.path(), 100).is_err());
    }
}
