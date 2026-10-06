use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;

use super::image_io;
use crate::models::dto::{ImageMeta, ImportResult, RejectedFile};
use crate::models::error::{AppError, AppResult};

/// An imported image tracked by the backend. The frontend only ever holds ids.
#[derive(Debug, Clone)]
pub struct ImageRecord {
    pub meta: ImageMeta,
    pub source: PathBuf,
    pub mask_path: Option<PathBuf>,
}

#[derive(Clone, Default, Debug)]
pub struct ImageRegistry {
    inner: Arc<Mutex<HashMap<String, ImageRecord>>>,
}

impl ImageRegistry {
    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, ImageRecord>>> {
        self.inner
            .lock()
            .map_err(|_| AppError::Internal("registry lock poisoned".into()))
    }

    /// Swap in the contents of another registry (a project that was read successfully).
    pub fn replace_with(&self, other: &ImageRegistry) -> AppResult<()> {
        let new = other.lock()?.clone();
        *self.lock()? = new;
        Ok(())
    }

    /// Forget every image (new/open project).
    pub fn clear(&self) -> AppResult<()> {
        self.lock()?.clear();
        Ok(())
    }

    pub fn get(&self, id: &str) -> AppResult<ImageRecord> {
        self.lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::InvalidInput(format!("unknown image id: {id}")))
    }

    pub fn set_mask(&self, id: &str, mask: Option<PathBuf>) -> AppResult<()> {
        if let Some(r) = self.lock()?.get_mut(id) {
            r.mask_path = mask;
        }
        Ok(())
    }

    fn find_by_source(&self, source: &Path) -> Option<ImageRecord> {
        self.lock()
            .ok()?
            .values()
            .find(|r| r.source == source)
            .cloned()
    }

    pub fn insert(&self, rec: ImageRecord) -> AppResult<()> {
        self.lock()?.insert(rec.meta.id.clone(), rec);
        Ok(())
    }
}

enum Outcome {
    Accepted(ImageRecord),
    Existing(ImageMeta),
    Rejected(RejectedFile),
}

fn import_one(
    raw: &Path,
    thumbs_dir: &Path,
    registry: &ImageRegistry,
    pixel_limit: u64,
) -> Outcome {
    let display = raw.display().to_string();
    let reject = |reason: String| {
        Outcome::Rejected(RejectedFile {
            path: display.clone(),
            reason,
        })
    };

    let source = match image_io::validate_input_path(&display) {
        Ok(p) => p,
        Err(e) => return reject(e.to_string()),
    };
    if !image_io::is_supported_extension(&source) {
        return reject("Unsupported file type. Use PNG, JPG, WEBP, BMP or TIFF.".into());
    }
    if let Some(existing) = registry.find_by_source(&source) {
        return Outcome::Existing(existing.meta);
    }

    let result = (|| -> AppResult<ImageRecord> {
        let (width, height, format) = image_io::read_header(&source, pixel_limit)?;
        let img = image_io::decode_oriented(&source, pixel_limit)?;
        let id = uuid::Uuid::new_v4().to_string();
        let thumb = thumbs_dir.join(format!("{id}.png"));
        image_io::save_thumbnail(&img, &thumb)?;
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(ImageRecord {
            meta: ImageMeta {
                id,
                path: source.display().to_string(),
                name,
                width,
                height,
                format: image_io::format_name(format),
                thumbnail_path: thumb.display().to_string(),
            },
            source: source.clone(),
            mask_path: None,
        })
    })();

    match result {
        Ok(rec) => Outcome::Accepted(rec),
        Err(e) => reject(e.to_string()),
    }
}

/// Import files/folders. Per-file failures are reported in `rejected`, never fatal.
pub fn import_paths(
    paths: &[PathBuf],
    recursive: bool,
    thumbs_dir: &Path,
    registry: &ImageRegistry,
    pixel_limit: u64,
) -> AppResult<ImportResult> {
    let mut seen = std::collections::HashSet::new();
    let candidates: Vec<PathBuf> = image_io::expand_paths(paths, recursive)
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect();

    let outcomes: Vec<Outcome> = candidates
        .par_iter()
        .map(|p| import_one(p, thumbs_dir, registry, pixel_limit))
        .collect();

    let (mut images, mut rejected) = (Vec::new(), Vec::new());
    for o in outcomes {
        match o {
            Outcome::Accepted(rec) => {
                images.push(rec.meta.clone());
                registry.insert(rec)?;
            }
            Outcome::Existing(meta) => images.push(meta),
            Outcome::Rejected(r) => rejected.push(r),
        }
    }
    Ok(ImportResult { images, rejected })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let p = dir.join(name);
        RgbImage::from_pixel(w, h, Rgb([200, 100, 50]))
            .save(&p)
            .unwrap();
        p
    }

    #[test]
    fn imports_valid_rejects_unsupported_and_dedupes() {
        let dir = tempfile::tempdir().unwrap();
        let png = write_png(dir.path(), "a b é.png", 64, 32);
        let txt = dir.path().join("notes.txt");
        std::fs::write(&txt, "hi").unwrap();
        let thumbs = dir.path().join("thumbs");
        let reg = ImageRegistry::default();

        let r = import_paths(&[png.clone(), txt], false, &thumbs, &reg, 100_000_000).unwrap();
        assert_eq!(r.images.len(), 1);
        assert_eq!((r.images[0].width, r.images[0].height), (64, 32));
        assert_eq!(r.images[0].format, "png");
        assert!(Path::new(&r.images[0].thumbnail_path).is_file());
        assert_eq!(r.rejected.len(), 1);
        assert!(r.rejected[0].reason.contains("Unsupported"));

        let again = import_paths(&[png], false, &thumbs, &reg, 100_000_000).unwrap();
        assert_eq!(again.images[0].id, r.images[0].id);
    }

    #[test]
    fn corrupt_file_is_rejected_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad.png");
        std::fs::write(&bad, b"definitely not a png").unwrap();
        let good = write_png(dir.path(), "ok.png", 8, 8);
        let reg = ImageRegistry::default();
        let r = import_paths(
            &[bad, good],
            false,
            &dir.path().join("t"),
            &reg,
            100_000_000,
        )
        .unwrap();
        assert_eq!(r.images.len(), 1);
        assert_eq!(r.rejected.len(), 1);
    }

    #[test]
    fn folder_import_respects_recursion() {
        let dir = tempfile::tempdir().unwrap();
        write_png(dir.path(), "top.png", 4, 4);
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        write_png(&sub, "deep.png", 4, 4);
        let thumbs = tempfile::tempdir().unwrap(); // outside the scanned folder
        let flat = import_paths(
            &[dir.path().to_path_buf()],
            false,
            &thumbs.path().join("t1"),
            &ImageRegistry::default(),
            100_000_000,
        )
        .unwrap();
        let deep = import_paths(
            &[dir.path().to_path_buf()],
            true,
            &thumbs.path().join("t2"),
            &ImageRegistry::default(),
            100_000_000,
        )
        .unwrap();
        assert_eq!(flat.images.len(), 1);
        assert_eq!(deep.images.len(), 2);
    }
}
