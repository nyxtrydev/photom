use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use image::metadata::Orientation;
use image::{DynamicImage, GrayImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbImage};

use crate::models::error::{AppError, AppResult};

pub const SUPPORTED_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];
/// Default pixel cap (100 MP). TODO(phase-3): make configurable via settings.
pub const DEFAULT_PIXEL_LIMIT: u64 = 100_000_000;
const MAX_ALLOC_BYTES: u64 = 3 * 1024 * 1024 * 1024;
pub const THUMBNAIL_SIZE: u32 = 256;

pub fn is_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Validate a path received over IPC: absolute, exists, regular file. Returns the canonical path.
pub fn validate_input_path(raw: &str) -> AppResult<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(AppError::InvalidInput(format!(
            "path is not absolute: {raw}"
        )));
    }
    let canon = std::fs::canonicalize(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::InvalidInput(format!("file not found: {raw}")),
        _ => AppError::from(e),
    })?;
    if !canon.is_file() {
        return Err(AppError::InvalidInput(format!("not a file: {raw}")));
    }
    Ok(canon)
}

/// Expand directories (optionally recursively) into candidate file paths. Files pass through.
pub fn expand_paths(paths: &[PathBuf], recursive: bool) -> Vec<PathBuf> {
    fn walk(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                if recursive {
                    walk(&p, recursive, out);
                }
            } else if is_supported_extension(&p) {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for p in paths {
        if p.is_dir() {
            walk(p, recursive, &mut out);
        } else {
            out.push(p.clone());
        }
    }
    out
}

fn open_decoder(path: &Path) -> AppResult<(impl ImageDecoder, ImageFormat)> {
    let mut reader = ImageReader::new(BufReader::new(File::open(path)?))
        .with_guessed_format()
        .map_err(AppError::from)?;
    let format = reader
        .format()
        .ok_or_else(|| AppError::UnsupportedFormat(path.display().to_string()))?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_ALLOC_BYTES);
    reader.limits(limits);
    let decoder = reader.into_decoder()?;
    Ok((decoder, format))
}

fn swaps_axes(o: Orientation) -> bool {
    matches!(
        o,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

pub fn format_name(f: ImageFormat) -> String {
    match f {
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Png => "png",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
        _ => "unknown",
    }
    .to_string()
}

/// Header-only read: oriented dimensions and format, without decoding pixels.
pub fn read_header(path: &Path, pixel_limit: u64) -> AppResult<(u32, u32, ImageFormat)> {
    let (mut decoder, format) = open_decoder(path)?;
    if !matches!(
        format,
        ImageFormat::Jpeg
            | ImageFormat::Png
            | ImageFormat::WebP
            | ImageFormat::Bmp
            | ImageFormat::Tiff
    ) {
        return Err(AppError::UnsupportedFormat(format_name(format)));
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (w, h) = decoder.dimensions();
    check_pixels(w, h, pixel_limit)?;
    Ok(if swaps_axes(orientation) {
        (h, w, format)
    } else {
        (w, h, format)
    })
}

fn check_pixels(w: u32, h: u32, limit: u64) -> AppResult<()> {
    if u64::from(w) * u64::from(h) > limit {
        return Err(AppError::OutOfMemory(format!(
            "image is {w}x{h}, above the {} MP limit",
            limit / 1_000_000
        )));
    }
    Ok(())
}

/// Decode with EXIF orientation applied.
pub fn decode_oriented(path: &Path, pixel_limit: u64) -> AppResult<DynamicImage> {
    let (mut decoder, _) = open_decoder(path)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (w, h) = decoder.dimensions();
    check_pixels(w, h, pixel_limit)?;
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// RGB8 for inference. Images with alpha are composited over white so transparent
/// areas do not leak undefined colour data into the model.
pub fn to_rgb_for_inference(img: &DynamicImage) -> RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u16::from(src[3]);
        for c in 0..3 {
            let v = (u16::from(src[c]) * a + 255 * (255 - a) + 127) / 255;
            dst[c] = v as u8;
        }
    }
    out
}

pub fn save_thumbnail(img: &DynamicImage, out: &Path) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE)
        .save_with_format(out, ImageFormat::Png)?;
    Ok(())
}

pub fn save_mask(mask: &GrayImage, out: &Path) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    mask.save_with_format(out, ImageFormat::Png)?;
    Ok(())
}

/// Tight bounding box of pixels with value >= `threshold`.
pub fn mask_bounding_box(
    mask: &GrayImage,
    threshold: u8,
) -> Option<crate::models::dto::BoundingBox> {
    let (w, h) = mask.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
    let mut any = false;
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] >= threshold {
            any = true;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    any.then(|| crate::models::dto::BoundingBox {
        x: x0,
        y: y0,
        width: x1 - x0 + 1,
        height: y1 - y0 + 1,
    })
}
