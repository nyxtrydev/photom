use image::{Rgba, RgbaImage};

use super::*;
use crate::services::import::ImageRegistry;

fn scale(s: u32) -> UpscaleParams {
    UpscaleParams {
        scale: Some(s),
        ..UpscaleParams::default()
    }
}

fn target(w: u32, h: u32) -> UpscaleParams {
    UpscaleParams {
        target: Some(TargetSize {
            width: w,
            height: h,
        }),
        ..UpscaleParams::default()
    }
}

// ---- output size ---------------------------------------------------------------------------

#[test]
fn a_scale_multiplies_both_sides() {
    assert_eq!(output_size((800, 600), &scale(2)).unwrap(), (1600, 1200));
    assert_eq!(output_size((800, 600), &scale(4)).unwrap(), (3200, 2400));
    assert_eq!(output_size((1, 1), &scale(4)).unwrap(), (4, 4));
}

#[test]
fn a_target_is_used_exactly_and_beats_the_scale() {
    assert_eq!(
        output_size((800, 600), &target(2000, 1500)).unwrap(),
        (2000, 1500)
    );
    let both = UpscaleParams {
        scale: Some(2),
        target: Some(TargetSize {
            width: 1000,
            height: 700,
        }),
        ..UpscaleParams::default()
    };
    assert_eq!(output_size((800, 600), &both).unwrap(), (1000, 700));
    // Only one side has to grow.
    assert_eq!(
        output_size((800, 600), &target(800, 601)).unwrap(),
        (800, 601)
    );
}

#[test]
fn nonsense_requests_are_refused_with_a_reason() {
    for (p, needle) in [
        (scale(3), "2x or 4x"),
        (scale(0), "2x or 4x"),
        (UpscaleParams::default(), "Choose a scale"),
        (target(0, 100), "at least 1"),
        (target(800, 600), "larger"),
        (target(100, 100), "larger"),
        (scale(4), "longest side"), // 20000 * 4 > 32768, checked below with a big source
    ] {
        let src = if needle == "longest side" {
            (20_000, 10)
        } else {
            (800, 600)
        };
        let e = output_size(src, &p).unwrap_err().to_string();
        assert!(e.contains(needle), "{e} should mention {needle}");
    }
    assert!(output_size((0, 10), &scale(2)).is_err());
}

#[test]
fn the_model_scale_is_the_smallest_that_covers_the_target() {
    assert_eq!(model_scale((800, 600), (1600, 1200)), 2);
    assert_eq!(model_scale((800, 600), (1000, 700)), 2);
    assert_eq!(model_scale((800, 600), (1601, 1200)), 4);
    assert_eq!(model_scale((800, 600), (3200, 2400)), 4);
    assert_eq!(model_scale((800, 600), (5000, 700)), 4);
}

// ---- estimate ------------------------------------------------------------------------------

#[test]
fn the_estimate_reports_the_exact_output_size_time_and_memory() {
    let e = estimate((800, 600), &scale(4), 100).unwrap();
    assert_eq!((e.out_w, e.out_h), (3200, 2400));
    assert!((e.megapixels - 7.68).abs() < 1e-9);
    assert!(
        e.eta_seconds > 0.0 && e.eta_seconds < 5.0,
        "{}",
        e.eta_seconds
    );
    assert!(e.memory_mb > 100 && e.memory_mb < 400, "{}", e.memory_mb);
    assert!(e.warnings.is_empty(), "{:?}", e.warnings);
    // Bigger results cost more of both.
    let more = estimate((800, 600), &target(6000, 4500), 100).unwrap();
    assert!(more.eta_seconds > e.eta_seconds && more.memory_mb > e.memory_mb);
}

#[test]
fn the_size_cap_blocks_and_a_near_cap_result_warns() {
    let e = estimate((4000, 3000), &scale(4), 100).unwrap(); // 192 MP
    assert_eq!((e.out_w, e.out_h), (16_000, 12_000));
    let w = e.warnings.iter().find(|w| w.code == "too-large").unwrap();
    assert!(w.blocking && w.message.contains("192.0 MP") && w.message.contains("100 MP"));
    assert!(check_allowed((4000, 3000), &scale(4), 100).is_err());
    assert!(check_allowed((4000, 3000), &scale(4), 200).is_ok());

    let near = estimate((6000, 4000), &scale(2), 100).unwrap(); // 96 MP
    assert!(near
        .warnings
        .iter()
        .any(|w| w.code == "large" && !w.blocking));
    assert!(check_allowed((6000, 4000), &scale(2), 100).is_ok());
}

#[test]
fn a_side_over_the_hard_limit_is_a_blocking_warning_not_an_error() {
    let e = estimate((20_000, 10), &scale(4), 100_000).unwrap();
    assert_eq!(e.out_w, 80_000);
    assert!(e
        .warnings
        .iter()
        .any(|w| w.code == "too-large-side" && w.blocking));
}

#[test]
fn already_large_and_tiny_inputs_get_notices() {
    let big = estimate((4000, 3000), &scale(2), 100).unwrap();
    assert!(big
        .warnings
        .iter()
        .any(|w| w.code == "already-large" && !w.blocking));
    let tiny = estimate((40, 30), &scale(4), 100).unwrap();
    assert!(tiny
        .warnings
        .iter()
        .any(|w| w.code == "tiny" && !w.blocking));
    let normal = estimate((800, 600), &scale(2), 100).unwrap();
    assert!(normal.warnings.is_empty());
}

// ---- the Standard upscaler -----------------------------------------------------------------

fn gradient(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        Rgba([
            (x * 255 / (w - 1)) as u8,
            (y * 255 / (h - 1)) as u8,
            90,
            255,
        ])
    })
}

#[test]
fn the_output_is_exactly_the_estimated_size_for_every_kind_of_request() {
    let src = gradient(40, 30);
    for p in [
        scale(2),
        scale(4),
        target(100, 70),
        target(41, 30),
        target(40, 90),
    ] {
        let e = estimate((40, 30), &p, 100).unwrap();
        let out = upscale_standard(&src, (e.out_w, e.out_h)).unwrap();
        assert_eq!(out.dimensions(), (e.out_w, e.out_h), "{p:?}");
    }
}

#[test]
fn it_refuses_to_shrink() {
    assert!(upscale_standard(&gradient(40, 30), (20, 15)).is_err());
    assert!(upscale_standard(&gradient(40, 30), (80, 20)).is_err());
}

#[test]
fn smooth_images_stay_smooth_and_keep_their_average_colour() {
    let src = gradient(32, 32);
    let out = upscale_standard(&src, (128, 128)).unwrap();
    let mean = |img: &RgbaImage, c: usize| {
        img.pixels().map(|p| f64::from(p[c])).sum::<f64>() / f64::from(img.width() * img.height())
    };
    for c in 0..3 {
        assert!((mean(&src, c) - mean(&out, c)).abs() < 2.0, "channel {c}");
    }
    // Interpolated, not blocky: neighbouring pixels differ by little.
    let step = (1..127)
        .map(|x| i32::from(out.get_pixel(x + 1, 60)[0]) - i32::from(out.get_pixel(x, 60)[0]))
        .map(i32::abs)
        .max()
        .unwrap();
    assert!(step <= 4, "step {step}");
}

#[test]
fn an_edge_gets_sharper_but_never_overshoots_wildly() {
    // A black / white step.
    let src = RgbaImage::from_fn(16, 16, |x, _| {
        let v = if x < 8 { 0 } else { 255 };
        Rgba([v, v, v, 255])
    });
    let out = upscale_standard(&src, (64, 64)).unwrap();
    let row: Vec<u8> = (0..64).map(|x| out.get_pixel(x, 30)[0]).collect();
    assert!(row[..20].iter().all(|&v| v <= 5) && row[44..].iter().all(|&v| v >= 250));
    // The transition is narrow (Lanczos + unsharp), not a wide smear.
    let width = row.iter().filter(|&&v| v > 20 && v < 235).count();
    assert!(width <= 6, "transition {width} px: {row:?}");
}

#[test]
fn transparent_cutouts_have_no_halo_and_keep_their_alpha() {
    // A red disc with a hard edge on a fully transparent background whose hidden colour is blue:
    // naive resizing would pull the blue into the edge.
    let src = RgbaImage::from_fn(40, 40, |x, y| {
        let inside = ((f64::from(x) - 19.5).powi(2) + (f64::from(y) - 19.5).powi(2)).sqrt() < 12.0;
        if inside {
            Rgba([220, 20, 20, 255])
        } else {
            Rgba([0, 0, 255, 0])
        }
    });
    let out = upscale_standard(&src, (160, 160)).unwrap();
    let mut visible = 0;
    for p in out.pixels() {
        if p[3] > 0 {
            visible += 1;
            // Every visible pixel is red-ish: no blue bleeding in from the hidden colour.
            assert!(p[2] < 40, "blue leaked into {p:?}");
            assert!(p[0] > 150, "{p:?}");
        }
    }
    assert!(visible > 1000);
    assert_eq!(out.get_pixel(0, 0)[3], 0); // the corner stays clear
    assert_eq!(out.get_pixel(80, 80)[3], 255); // the middle stays solid
                                               // The disc keeps its size (area scales by 16).
    let area: f64 = out.pixels().map(|p| f64::from(p[3]) / 255.0).sum();
    let want = std::f64::consts::PI * 12.0 * 12.0 * 16.0;
    assert!((area - want).abs() / want < 0.04, "{area} vs {want}");
}

#[test]
fn fully_transparent_pixels_are_not_sharpened_into_existence() {
    let src = RgbaImage::from_pixel(10, 10, Rgba([5, 6, 7, 0]));
    let out = upscale_standard(&src, (40, 40)).unwrap();
    assert!(out.pixels().all(|p| p[3] == 0));
}

// ---- loupe ---------------------------------------------------------------------------------

#[test]
fn the_loupe_shows_the_original_enlarged_beside_the_result() {
    let original = gradient(20, 20);
    let result = upscale_standard(&original, (80, 80)).unwrap();
    let crop = loupe_crop(&original, &result, 40, 40, 32).unwrap();
    assert_eq!(crop.dimensions(), (64, 32));
    // Right half is exactly the result's pixels.
    assert_eq!(crop.get_pixel(32, 0), result.get_pixel(24, 24));
    assert_eq!(crop.get_pixel(63, 31), result.get_pixel(55, 55));
    // Left half is the original at the same place: close to the result for a smooth image.
    let a = crop.get_pixel(16, 16);
    let b = crop.get_pixel(48, 16);
    assert!(
        (i32::from(a[0]) - i32::from(b[0])).abs() < 12,
        "{a:?} {b:?}"
    );
}

#[test]
fn the_loupe_is_clamped_at_the_edges_and_to_sane_sizes() {
    let original = gradient(20, 20);
    let result = upscale_standard(&original, (80, 80)).unwrap();
    for (x, y) in [(0, 0), (79, 79), (0, 79), (1000, 1000)] {
        let c = loupe_crop(&original, &result, x, y, 32).unwrap();
        assert_eq!(c.dimensions(), (64, 32));
    }
    assert_eq!(
        loupe_crop(&original, &result, 40, 40, 2).unwrap().height(),
        16
    ); // minimum
    assert!(loupe_crop(&original, &result, 5, 5, 512).is_err()); // larger than the result
}

// ---- keep / discard ------------------------------------------------------------------------

fn pending(dir: &Path, id: &str, s: Option<u32>) -> PendingResult {
    let path = UpscaleStore::dir(dir, id).join("pending-x.png");
    save_png(&gradient(20, 20), &path).unwrap();
    PendingResult {
        id: id.into(),
        path: path.display().to_string(),
        width: 20,
        height: 20,
        scale: s,
        engine: Engine::Standard,
    }
}

#[test]
fn keeping_moves_the_result_into_the_registry_and_clears_the_pending_one() {
    let dir = tempfile::tempdir().unwrap();
    let reg = ImageRegistry::default();
    let store = UpscaleStore::default();
    store
        .set_pending(pending(dir.path(), "a", Some(2)))
        .unwrap();
    let kept = keep(&reg, &store, dir.path(), "a").unwrap();
    assert!(kept.path.is_file() && kept.path.ends_with("kept_2x.png"));
    assert_eq!((kept.width, kept.scale), (20, Some(2)));
    assert_eq!(reg.upscaled("a").unwrap(), Some(kept));
    assert!(store.pending("a").unwrap().is_none());
    // Nothing left to keep.
    assert!(keep(&reg, &store, dir.path(), "a").is_err());
}

#[test]
fn keeping_a_different_scale_replaces_the_older_kept_file() {
    let dir = tempfile::tempdir().unwrap();
    let reg = ImageRegistry::default();
    let store = UpscaleStore::default();
    store
        .set_pending(pending(dir.path(), "a", Some(2)))
        .unwrap();
    let first = keep(&reg, &store, dir.path(), "a").unwrap();
    store.set_pending(pending(dir.path(), "a", None)).unwrap();
    let second = keep(&reg, &store, dir.path(), "a").unwrap();
    assert!(!first.path.exists(), "the 2x file is gone");
    assert!(second.path.is_file() && second.path.ends_with("kept_custom.png"));
    assert_eq!(reg.upscaled("a").unwrap().unwrap().scale, None);
}

#[test]
fn a_new_pending_result_deletes_the_unreviewed_one_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = UpscaleStore::default();
    let a = pending(dir.path(), "a", Some(2));
    let old = PathBuf::from(&a.path);
    store.set_pending(a).unwrap();
    let b = PendingResult {
        path: UpscaleStore::dir(dir.path(), "a")
            .join("pending-y.png")
            .display()
            .to_string(),
        ..pending(dir.path(), "a", Some(4))
    };
    store.set_pending(b).unwrap();
    assert!(!old.exists());
    assert_eq!(store.pending("a").unwrap().unwrap().scale, Some(4));
}

#[test]
fn discard_removes_both_the_pending_and_the_kept_versions() {
    let dir = tempfile::tempdir().unwrap();
    let reg = ImageRegistry::default();
    let store = UpscaleStore::default();
    store
        .set_pending(pending(dir.path(), "a", Some(2)))
        .unwrap();
    let kept = keep(&reg, &store, dir.path(), "a").unwrap();
    let p = pending(dir.path(), "a", Some(4));
    let pending_path = PathBuf::from(&p.path);
    store.set_pending(p).unwrap();
    // Rejecting only the re-run leaves the earlier kept version alone ...
    discard(&reg, &store, "a", false).unwrap();
    assert!(kept.path.exists() && !pending_path.exists());
    assert!(reg.upscaled("a").unwrap().is_some());
    // ... and going back to the original removes it.
    discard(&reg, &store, "a", true).unwrap();
    assert!(!kept.path.exists());
    assert!(reg.upscaled("a").unwrap().is_none() && store.pending("a").unwrap().is_none());
    discard(&reg, &store, "a", true).unwrap(); // idempotent
}

#[test]
fn the_registry_forgets_kept_versions_when_cleared_and_copies_them_on_replace() {
    let reg = ImageRegistry::default();
    let k = KeptUpscale {
        path: PathBuf::from("/x/k.png"),
        width: 4,
        height: 4,
        scale: Some(2),
        engine: Engine::Standard,
    };
    reg.set_upscaled("a", Some(k.clone())).unwrap();
    let other = ImageRegistry::default();
    other.replace_with(&reg).unwrap();
    assert_eq!(other.upscaled("a").unwrap(), Some(k));
    reg.clear().unwrap();
    assert!(reg.upscaled("a").unwrap().is_none());
}

#[test]
fn saved_results_are_valid_pngs_with_their_alpha() {
    let dir = tempfile::tempdir().unwrap();
    let img = RgbaImage::from_fn(8, 8, |x, _| Rgba([1, 2, 3, if x < 4 { 0 } else { 255 }]));
    let p = dir.path().join("a/b/r.png");
    save_png(&img, &p).unwrap();
    assert_eq!(image::open(&p).unwrap().to_rgba8().get_pixel(0, 0)[3], 0);
    let opaque = gradient(8, 8);
    save_png(&opaque, &p).unwrap();
    assert!(!image::open(&p).unwrap().color().has_alpha());
}

/// Speed check for the estimate constants: `cargo test --lib upscale_speed -- --ignored --nocapture`.
#[test]
#[ignore]
fn upscale_speed_on_a_one_megapixel_image() {
    let src = gradient(1000, 1000);
    let t = std::time::Instant::now();
    let out = upscale_standard(&src, (4000, 4000)).unwrap();
    let secs = t.elapsed().as_secs_f64();
    let est = estimate((1000, 1000), &scale(4), 1000).unwrap();
    println!(
        "1 MP -> 16 MP: {secs:.2}s actual, {:.2}s estimated",
        est.eta_seconds
    );
    assert_eq!(out.dimensions(), (4000, 4000));
}

#[test]
fn with_kept_swaps_the_source_and_scales_the_state() {
    use crate::models::dto::ImageMeta;
    use crate::services::exporter::ItemState;
    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("kept.png");
    RgbaImage::from_pixel(8, 6, image::Rgba([1, 2, 3, 255]))
        .save(&png)
        .unwrap();
    let rec = crate::services::import::ImageRecord {
        meta: ImageMeta {
            id: "a".into(),
            path: "/o/a.jpg".into(),
            name: "a.jpg".into(),
            width: 4,
            height: 3,
            format: "jpeg".into(),
            thumbnail_path: String::new(),
        },
        source: "/o/a.jpg".into(),
        mask_path: None,
    };
    let kept = KeptUpscale {
        path: png.clone(),
        width: 8,
        height: 6,
        scale: Some(2),
        engine: Engine::Standard,
    };
    let (r, s) = with_kept(&rec, Some(kept.clone()), &ItemState::default());
    assert_eq!(r.source, png);
    assert_eq!(s.scale(), 2.0);
    // Nothing kept, or its file gone: unchanged.
    let (r, s) = with_kept(&rec, None, &ItemState::default());
    assert_eq!(r.source, rec.source);
    assert_eq!(s.scale(), 1.0);
    let gone = KeptUpscale {
        path: dir.path().join("missing.png"),
        ..kept
    };
    let (r, _) = with_kept(&rec, Some(gone), &ItemState::default());
    assert_eq!(r.source, rec.source);
}

#[test]
fn the_light_denoise_smooths_noise_but_keeps_edges_and_alpha() {
    // Left half dark, right half light, with +-6 noise; a clear column on the far left.
    let img = RgbaImage::from_fn(40, 20, |x, y| {
        let base: i32 = if x < 20 { 60 } else { 190 };
        let n = ((x * 7 + y * 13) % 5) as i32 * 3 - 6;
        let v = (base + n) as u8;
        image::Rgba([v, v, v, if x == 0 { 0 } else { 255 }])
    });
    let out = denoise_light(&img);
    let spread = |im: &RgbaImage, x0: u32, x1: u32| {
        let v: Vec<u8> = (x0..x1)
            .flat_map(|x| (2..18).map(move |y| (x, y)))
            .map(|(x, y)| im.get_pixel(x, y)[0])
            .collect();
        v.iter().max().unwrap() - v.iter().min().unwrap()
    };
    assert!(
        spread(&out, 3, 17) < spread(&img, 3, 17),
        "noise is reduced"
    );
    // The edge between the halves survives (no smearing across it).
    assert!(out.get_pixel(17, 10)[0] < 80 && out.get_pixel(22, 10)[0] > 170);
    // Alpha is untouched and a clear pixel stays as it was.
    assert!(out.pixels().zip(img.pixels()).all(|(a, b)| a[3] == b[3]));
    assert_eq!(out.get_pixel(0, 5), img.get_pixel(0, 5));
}
