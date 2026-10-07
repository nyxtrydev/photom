//! The whole chain a user runs: cut-out mask, upscale and Keep, shadow, export.

use image::{GrayImage, Luma, Rgb, RgbImage};

use crate::models::dto::ImageMeta;
use crate::services::exporter::{
    self, BackgroundMode, CropOptions, ExportOptions, ItemRequest, ItemState, SizeMode, SizeOptions,
};
use crate::services::import::{ImageRecord, ImageRegistry};
use crate::services::upscale::{self, Engine, PendingResult, UpscaleParams, UpscaleStore};

fn shadow() -> serde_json::Value {
    serde_json::json!({"enabled": true, "autoExpand": true, "layers": [
        {"type": "drop", "angle": 135, "distance": 20, "blur": 0, "opacity": 1, "color": "#000000"}]})
}

#[test]
fn remove_background_upscale_shadow_export_gives_the_upscaled_size() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    let src = dir.path().join("photo.png");
    RgbImage::from_pixel(120, 90, Rgb([200, 100, 30]))
        .save(&src)
        .unwrap();
    let mask = dir.path().join("mask.png");
    GrayImage::from_fn(120, 90, |x, y| {
        Luma([if (30..70).contains(&x) && (20..60).contains(&y) {
            255
        } else {
            0
        }])
    })
    .save(&mask)
    .unwrap();
    let images = ImageRegistry::default();
    let rec = ImageRecord {
        meta: ImageMeta {
            id: "a".into(),
            path: src.display().to_string(),
            name: "photo.png".into(),
            width: 120,
            height: 90,
            format: "png".into(),
            thumbnail_path: String::new(),
        },
        source: src.clone(),
        mask_path: Some(mask),
    };
    images.insert(rec.clone()).unwrap();

    // Upscale 2x (Standard) and keep, exactly as the commands do.
    let store = UpscaleStore::default();
    let original = image::open(&src).unwrap().to_rgba8();
    let params = UpscaleParams {
        scale: Some(2),
        ..UpscaleParams::default()
    };
    let out = upscale::check_allowed((120, 90), &params, 100).unwrap();
    let big = upscale::upscale_standard(&original, out).unwrap();
    let pending = UpscaleStore::dir(&cache, "a").join("pending-x.png");
    upscale::save_png(&big, &pending).unwrap();
    store
        .set_pending(PendingResult {
            id: "a".into(),
            path: pending.display().to_string(),
            width: big.width(),
            height: big.height(),
            scale: Some(2),
            engine: Engine::Standard,
        })
        .unwrap();
    upscale::keep(&images, &store, &cache, "a").unwrap();

    let opts = ExportOptions {
        folder: dir.path().join("out").display().to_string(),
        background: BackgroundMode::Transparent,
        crop: CropOptions::default(),
        size: SizeOptions {
            mode: SizeMode::Original,
            ..SizeOptions::default()
        },
        ..ExportOptions::default()
    };
    let state = ItemState {
        shadow: Some(shadow()),
        ..ItemState::default()
    };
    let export = |rec: &ImageRecord, state: &ItemState| {
        exporter::export_item(&ItemRequest {
            rec,
            state,
            options: &opts,
            index: 1,
            total: 1,
            date: "2026-10-06",
            pixel_limit: 100_000_000,
        })
        .unwrap()
        .1
    };

    // Without the upscale: the original size plus the shadow's margin.
    let plain = export(&rec, &state);
    // With it: the same picture at twice the size, in the same places.
    let (work, work_state) = upscale::with_kept(&rec, images.upscaled("a").unwrap(), &state);
    let up = export(&work, &work_state);
    assert!(
        up.width().abs_diff(plain.width() * 2) <= 2,
        "{:?} vs {:?}",
        up.dimensions(),
        plain.dimensions()
    );
    assert!(up.height().abs_diff(plain.height() * 2) <= 2);
    // Subject (orange) opaque in the middle of its box, shadow (black) past its corner, clear
    // corner untouched, at both sizes.
    let at = |im: &image::RgbaImage, x: u32, y: u32, k: u32| *im.get_pixel(x * k, y * k);
    assert_eq!(at(&plain, 50, 40, 1).0[3], 255);
    assert_eq!(at(&up, 50, 40, 2).0[3], 255);
    assert!(at(&up, 50, 40, 2).0[0] > 150);
    let (sx, sy) = (75, 65); // below and right of the subject: inside the 14 px drop offset
    assert_eq!(at(&plain, sx, sy, 1).0, [0, 0, 0, 255]);
    assert_eq!(at(&up, sx, sy, 2).0, [0, 0, 0, 255]);
    assert_eq!(at(&up, 5, 5, 2).0[3], 0);
    // Reverting returns to the original size.
    upscale::discard(&images, &store, "a", true).unwrap();
    let (work, work_state) = upscale::with_kept(&rec, images.upscaled("a").unwrap(), &state);
    assert_eq!(export(&work, &work_state).dimensions(), plain.dimensions());
}
