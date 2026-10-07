//! Streaming SHA-256 and size verification of downloaded files.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

use crate::models::error::{AppError, AppResult};

pub const CORRUPT_MESSAGE: &str = "The download was corrupted and has been discarded.";

/// Check `path` against the expected size and SHA-256. Blocking: run it on a blocking thread.
/// `cancel` is polled once per MiB so a cancel is honoured even on a very large file.
pub fn verify_file(
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let size = std::fs::metadata(path)?.len();
    if size != expected_size {
        return Err(AppError::HashMismatch(format!(
            "{CORRUPT_MESSAGE} (size {size}, expected {expected_size})"
        )));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(AppError::HashMismatch(CORRUPT_MESSAGE.into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn accepts_a_matching_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f");
        std::fs::write(&p, b"abc").unwrap();
        assert!(verify_file(&p, ABC, 3, &AtomicBool::new(false)).is_ok());
        assert!(verify_file(&p, &ABC.to_uppercase(), 3, &AtomicBool::new(false)).is_ok());
    }

    #[test]
    fn rejects_wrong_content_and_wrong_size() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f");
        std::fs::write(&p, b"abd").unwrap();
        let e = verify_file(&p, ABC, 3, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(e.code(), "HashMismatch");
        let e = verify_file(&p, ABC, 4, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(e.code(), "HashMismatch");
    }

    #[test]
    fn honours_cancel() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f");
        std::fs::write(&p, b"abc").unwrap();
        let e = verify_file(&p, ABC, 3, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(e.code(), "Cancelled");
    }
}
