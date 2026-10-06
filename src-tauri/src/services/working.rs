use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use fast_image_resize::{FilterType, PixelType};
use image::codecs::jpeg::JpegEncoder;
use image::{GrayImage, ImageEncoder, RgbImage};

use super::image_io;
use super::import::ImageRecord;
use super::preprocess::resize_u8;
use crate::models::dto::{BackgroundImage, WorkingSet};
use crate::models::error::{AppError, AppResult};

/// Editing happens at this resolution (spec: edit on a downscaled working mask).
pub const DEFAULT_WORKING_SIDE: u32 = 2048;
const MAX_WORKING_SIDE: u32 = 4096;

/// Working size for a source, never upscaling.
pub fn working_size(w: u32, h: u32, max_side: u32) -> (u32, u32) {
    let longest = w.max(h);
    if longest <= max_side {
        return (w, h);
    }
    let s = f64::from(max_side) / f64::from(longest);
    (
        ((f64::from(w) * s).round() as u32).max(1),
        ((f64::from(h) * s).round() as u32).max(1),
    )
}

fn save_jpeg(rgb: &RgbImage, out: &Path) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = BufWriter::new(File::create(out)?);
    JpegEncoder::new_with_quality(file, 92)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(AppError::from)
}

pub(crate) fn resize_rgb(rgb: &RgbImage, size: (u32, u32)) -> AppResult<RgbImage> {
    if rgb.dimensions() == size {
        return Ok(rgb.clone());
    }
    let data = resize_u8(
        rgb.as_raw(),
        rgb.dimensions(),
        size,
        PixelType::U8x3,
        FilterType::Lanczos3,
    )?;
    RgbImage::from_raw(size.0, size.1, data)
        .ok_or_else(|| AppError::Internal("preview buffer size mismatch".into()))
}

pub(crate) fn resize_gray(mask: &GrayImage, size: (u32, u32)) -> AppResult<GrayImage> {
    if mask.dimensions() == size {
        return Ok(mask.clone());
    }
    let data = resize_u8(
        mask.as_raw(),
        mask.dimensions(),
        size,
        PixelType::U8,
        FilterType::Bilinear,
    )?;
    GrayImage::from_raw(size.0, size.1, data)
        .ok_or_else(|| AppError::Internal("mask buffer size mismatch".into()))
}

/// Create (or reuse) the working preview and a working-size copy of the current model mask.
pub fn prepare(
    rec: &ImageRecord,
    cache_dir: &Path,
    max_side: Option<u32>,
    pixel_limit: u64,
) -> AppResult<WorkingSet> {
    let max_side = max_side
        .unwrap_or(DEFAULT_WORKING_SIDE)
        .clamp(256, MAX_WORKING_SIDE);
    let (sw, sh) = (rec.meta.width, rec.meta.height);
    let (ww, wh) = working_size(sw, sh, max_side);
    let work_dir = cache_dir.join("work");
    std::fs::create_dir_all(&work_dir)?;

    let preview = work_dir.join(format!("{}-{max_side}.jpg", rec.meta.id));
    if !preview.is_file() {
        let img = image_io::decode_oriented(&rec.source, pixel_limit)?;
        let rgb = image_io::to_rgb_for_inference(&img);
        drop(img);
        save_jpeg(&resize_rgb(&rgb, (ww, wh))?, &preview)?;
    }

    let mask_path = match &rec.mask_path {
        Some(p) if p.is_file() => {
            let mask = image::open(p)?.to_luma8();
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("mask");
            let out = work_dir.join(format!("{}-{max_side}-{stem}.mask.png", rec.meta.id));
            image_io::save_mask(&resize_gray(&mask, (ww, wh))?, &out)?;
            Some(out.display().to_string())
        }
        _ => None,
    };

    Ok(WorkingSet {
        id: rec.meta.id.clone(),
        preview_path: preview.display().to_string(),
        mask_path,
        work_width: ww,
        work_height: wh,
        source_width: sw,
        source_height: sh,
    })
}

/// Import a user-chosen background picture as a downscaled cache copy.
pub fn prepare_background(
    raw_path: &str,
    cache_dir: &Path,
    pixel_limit: u64,
) -> AppResult<BackgroundImage> {
    let source = image_io::validate_input_path(raw_path)?;
    if !image_io::is_supported_extension(&source) {
        return Err(AppError::UnsupportedFormat(
            "Use a PNG, JPG, WEBP, BMP or TIFF image.".into(),
        ));
    }
    let img = image_io::decode_oriented(&source, pixel_limit)?;
    let rgb = image_io::to_rgb_for_inference(&img);
    drop(img);
    let (w, h) = working_size(rgb.width(), rgb.height(), DEFAULT_WORKING_SIDE);
    let small = resize_rgb(&rgb, (w, h))?;
    let out = cache_dir
        .join("bg")
        .join(format!("{}.jpg", uuid::Uuid::new_v4()));
    save_jpeg(&small, &out)?;
    Ok(BackgroundImage {
        cache_path: out.display().to_string(),
        source_path: source.display().to_string(),
        width: rgb.width(),
        height: rgb.height(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::dto::ImageMeta;
    use image::{Luma, Rgb};

    #[test]
    fn working_size_never_upscales_and_keeps_aspect() {
        assert_eq!(working_size(1000, 500, 2560), (1000, 500));
        assert_eq!(working_size(5000, 2500, 2500), (2500, 1250));
        assert_eq!(working_size(2500, 5000, 1000), (500, 1000));
        assert_eq!(working_size(10_000, 1, 100), (100, 1));
    }

    fn record(dir: &Path, w: u32, h: u32, with_mask: bool) -> ImageRecord {
        let src = dir.join("src.png");
        RgbImage::from_pixel(w, h, Rgb([10, 200, 30]))
            .save(&src)
            .unwrap();
        let mask_path = with_mask.then(|| {
            let p = dir.join("mask.png");
            GrayImage::from_pixel(w, h, Luma([255])).save(&p).unwrap();
            p
        });
        ImageRecord {
            meta: ImageMeta {
                id: "abc".into(),
                path: src.display().to_string(),
                name: "src.png".into(),
                width: w,
                height: h,
                format: "png".into(),
                thumbnail_path: String::new(),
            },
            source: src,
            mask_path,
        }
    }

    #[test]
    fn prepares_preview_and_mask_at_working_size() {
        let dir = tempfile::tempdir().unwrap();
        let rec = record(dir.path(), 800, 400, true);
        let cache = dir.path().join("cache");
        let ws = prepare(&rec, &cache, Some(400), 100_000_000).unwrap();
        assert_eq!((ws.work_width, ws.work_height), (400, 200));
        let preview = image::open(&ws.preview_path).unwrap();
        assert_eq!((preview.width(), preview.height()), (400, 200));
        let mask = image::open(ws.mask_path.unwrap()).unwrap().to_luma8();
        assert_eq!(mask.dimensions(), (400, 200));
        assert_eq!(mask.get_pixel(10, 10)[0], 255);
    }

    #[test]
    fn mask_is_none_before_removal_runs() {
        let dir = tempfile::tempdir().unwrap();
        let rec = record(dir.path(), 64, 64, false);
        let ws = prepare(&rec, &dir.path().join("c"), None, 100_000_000).unwrap();
        assert!(ws.mask_path.is_none());
        assert_eq!((ws.work_width, ws.work_height), (64, 64));
    }

    #[test]
    fn background_is_copied_into_cache() {
        let dir = tempfile::tempdir().unwrap();
        let rec = record(dir.path(), 50, 40, false);
        let bg = prepare_background(&rec.meta.path, &dir.path().join("c"), 100_000_000).unwrap();
        assert!(Path::new(&bg.cache_path).is_file());
        assert_eq!((bg.width, bg.height), (50, 40));
        let bad =
            prepare_background("/definitely/missing.png", dir.path(), 100_000_000).unwrap_err();
        assert_eq!(bad.code(), "InvalidInput");
    }
}
