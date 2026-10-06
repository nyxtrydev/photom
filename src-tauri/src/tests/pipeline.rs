use std::time::Instant;

use image::{Rgb, RgbImage};

use crate::infra::model_manager::{self, ModelManager};
use crate::models::dto::{DevicePref, ModelKind};
use crate::services::inference::InferenceEngine;

/// A bright orange disc on a bluish gradient: a simple but non-trivial subject.
fn synthetic(w: u32, h: u32) -> RgbImage {
    let (cx, cy, r) = (w as f32 / 2.0, h as f32 / 2.0, h as f32 / 3.0);
    RgbImage::from_fn(w, h, |x, y| {
        let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
        if d < r {
            Rgb([230, 120, 40])
        } else {
            Rgb([40 + (x * 60 / w) as u8, 60, 120 + (y * 80 / h) as u8])
        }
    })
}

#[test]
fn model_pipeline_is_deterministic_and_matches_source_size() {
    let models = ModelManager::new(
        Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models")),
        None,
    );
    let Some(path) = models.locate(ModelKind::Fast) else {
        eprintln!("SKIP: Fast model not present in resources/models");
        return;
    };
    let spec = model_manager::spec(ModelKind::Fast);
    let engine = InferenceEngine::default();
    let img = synthetic(1200, 900);

    let t = Instant::now();
    let (a, _) = engine
        .remove_background(&path, &spec, DevicePref::Cpu, &img)
        .unwrap();
    eprintln!("cold run (incl. model load): {:?}", t.elapsed());
    let t = Instant::now();
    let (b, device) = engine
        .remove_background(&path, &spec, DevicePref::Cpu, &img)
        .unwrap();
    eprintln!("warm run: {:?} on {device:?}", t.elapsed());

    assert_eq!(a.dimensions(), (1200, 900));
    assert_eq!(a.as_raw(), b.as_raw(), "same input must give the same mask");
    let (lo, hi) = a
        .iter()
        .fold((255u8, 0u8), |(l, h), &v| (l.min(v), h.max(v)));
    assert!(
        hi > 200 && lo < 55,
        "mask should span the alpha range (lo={lo}, hi={hi})"
    );
    assert!(engine.is_loaded(ModelKind::Fast, DevicePref::Cpu));
}

#[test]
fn missing_model_is_a_typed_error() {
    let dir = tempfile::tempdir().unwrap();
    let models = ModelManager::new(Some(dir.path().to_path_buf()), None);
    // search_dirs also includes the dev tree in debug builds, so only assert on a kind
    // that is never bundled.
    assert_eq!(
        models.require(ModelKind::Quality).unwrap_err().code(),
        "ModelMissing"
    );
}

/// Manual check: `PHOTOM_SAMPLE=in.png PHOTOM_OUT=mask.png cargo test --release -- --ignored sample`
#[test]
#[ignore]
fn sample() {
    let (Ok(input), Ok(out)) = (std::env::var("PHOTOM_SAMPLE"), std::env::var("PHOTOM_OUT")) else {
        return;
    };
    let models = ModelManager::new(
        Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models")),
        None,
    );
    let path = models.require(ModelKind::Fast).unwrap();
    let img = crate::services::image_io::decode_oriented(std::path::Path::new(&input), 100_000_000)
        .unwrap();
    let rgb = crate::services::image_io::to_rgb_for_inference(&img);
    let (mask, _) = InferenceEngine::default()
        .remove_background(
            &path,
            &model_manager::spec(ModelKind::Fast),
            DevicePref::Cpu,
            &rgb,
        )
        .unwrap();
    mask.save(out).unwrap();
}

/// Acceptance: a 12 MP, EXIF-rotated JPEG goes import -> removal and yields a mask at the
/// oriented source resolution. Timing is printed (target: < 6 s warm on a laptop CPU).
#[test]
fn twelve_megapixel_jpeg_end_to_end() {
    let models = ModelManager::new(
        Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models")),
        None,
    );
    let Some(path) = models.locate(ModelKind::Fast) else {
        eprintln!("SKIP: Fast model not present");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("big photo é.jpg");
    // Stored 4000x3000, EXIF orientation 6 => displayed 3000x4000.
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgb8(synthetic(4000, 3000))
        .write_to(
            &mut std::io::Cursor::new(&mut jpeg),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    std::fs::write(&file, super::images::jpeg_with_orientation_from(jpeg, 6)).unwrap();

    let registry = crate::services::import::ImageRegistry::default();
    let imported = crate::services::import::import_paths(
        &[file],
        false,
        &dir.path().join("thumbs"),
        &registry,
        100_000_000,
    )
    .unwrap();
    let meta = &imported.images[0];
    assert_eq!((meta.width, meta.height), (3000, 4000));

    let engine = InferenceEngine::default();
    let spec = model_manager::spec(ModelKind::Fast);
    let run = || {
        let t = Instant::now();
        let rec = registry.get(&meta.id).unwrap();
        let img = crate::services::image_io::decode_oriented(&rec.source, 100_000_000).unwrap();
        let rgb = crate::services::image_io::to_rgb_for_inference(&img);
        let (mask, _) = engine
            .remove_background(&path, &spec, DevicePref::Cpu, &rgb)
            .unwrap();
        (mask, t.elapsed())
    };
    let (_, cold) = run();
    let (mask, warm) = run();
    eprintln!("12MP cold {cold:?}, warm {warm:?}");
    assert_eq!(mask.dimensions(), (3000, 4000));
}

/// Quality gate for the fp16 Fast model: its masks must match the fp32 model's.
/// `PHOTOM_SAMPLE=photo.png cargo test --release -- --ignored fp16 --nocapture`
#[test]
#[ignore]
fn fp16_matches_fp32() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
    let (f32p, f16p) = (
        dir.join("isnet-general-use.onnx"),
        dir.join("isnet-general-use-fp16.onnx"),
    );
    if !f32p.is_file() || !f16p.is_file() {
        eprintln!("SKIP: need both model files");
        return;
    }
    // Both candidate files are passed explicitly, so the checksum check is not involved.
    let spec = model_manager::spec(ModelKind::Fast);
    let mut inputs: Vec<RgbImage> = vec![synthetic(900, 700)];
    if let Ok(p) = std::env::var("PHOTOM_SAMPLE") {
        let img = crate::services::image_io::decode_oriented(std::path::Path::new(&p), 100_000_000)
            .unwrap();
        inputs.push(crate::services::image_io::to_rgb_for_inference(&img));
    }
    for (n, img) in inputs.iter().enumerate() {
        let run = |path: &std::path::Path| {
            let engine = InferenceEngine::default();
            engine
                .remove_background(path, &spec, DevicePref::Cpu, img)
                .unwrap(); // warm up
            let t = Instant::now();
            let (m, _) = engine
                .remove_background(path, &spec, DevicePref::Cpu, img)
                .unwrap();
            (m, t.elapsed())
        };
        let ((a, ta), (b, tb)) = (run(&f32p), run(&f16p));
        let (mut inter, mut union) = (0u64, 0u64);
        for (x, y) in a.iter().zip(b.iter()) {
            let (x, y) = (*x >= 128, *y >= 128);
            inter += (x && y) as u64;
            union += (x || y) as u64;
        }
        let mad = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| (*x as i64 - *y as i64).unsigned_abs())
            .sum::<u64>() as f64
            / a.len() as f64;
        let iou = inter as f64 / union.max(1) as f64;
        eprintln!(
            "input {n}: fp32 {ta:?} vs fp16 {tb:?}; IoU {iou:.4}; mean abs diff {mad:.3}/255"
        );
        assert!(iou > 0.98, "fp16 mask diverges from fp32 (IoU {iou})");
        assert!(
            mad < 3.0,
            "fp16 mask diverges from fp32 (mean abs diff {mad})"
        );
    }
}
