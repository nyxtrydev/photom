use std::cell::Cell;

use image::{Rgba, RgbaImage};

use super::upscale_ai::*;
use crate::models::error::AppError;

/// A stand-in model: nearest-neighbour enlargement, so the right answer is known exactly.
fn nearest(scale: u32) -> impl FnMut(&[f32]) -> crate::models::error::AppResult<Vec<f32>> {
    move |t: &[f32]| {
        let (s, n) = (scale as usize, TILE as usize);
        let m = n * s;
        let mut out = vec![0f32; 3 * m * m];
        for c in 0..3 {
            for y in 0..m {
                for x in 0..m {
                    out[c * m * m + y * m + x] = t[c * n * n + (y / s) * n + x / s];
                }
            }
        }
        Ok(out)
    }
}

fn pattern(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        Rgba([
            (x * 7 % 256) as u8,
            (y * 13 % 256) as u8,
            ((x + y) * 3 % 256) as u8,
            255,
        ])
    })
}

fn run(src: &RgbaImage, scale: u32) -> RgbaImage {
    let never = || false;
    let none = |_: u32, _: u32| {};
    let hooks = TileHooks {
        cancelled: &never,
        progress: &none,
    };
    upscale_tiled(src, scale, &mut nearest(scale), &hooks).unwrap()
}

#[test]
fn tile_starts_cover_the_axis_with_overlap() {
    assert_eq!(tile_starts(100, 256, 16), vec![0]);
    assert_eq!(tile_starts(256, 256, 16), vec![0]);
    for len in [257u32, 300, 512, 1000, 4096] {
        let s = tile_starts(len, 256, 16);
        assert_eq!(*s.last().unwrap() + 256, len, "last tile ends at the edge");
        assert!(s.windows(2).all(|p| p[1] > p[0] && p[0] + 256 - p[1] >= 16));
    }
}

#[test]
fn weights_ramp_only_where_a_neighbour_exists() {
    let w = axis_weights(64, 8, false, false);
    assert!(w.iter().all(|v| *v == 1.0));
    let w = axis_weights(64, 8, true, true);
    assert!(w[0] > 0.0 && w[0] < w[4] && w[4] < w[8] && w[8] == 1.0);
    assert!((w[0] - w[63]).abs() < 1e-6);
    assert!(w.iter().all(|v| *v > 0.0));
}

#[test]
fn blended_tiles_have_no_seams() {
    // 600x300 needs several tiles each way; a perfect model must reproduce a plain enlargement.
    let src = pattern(600, 300);
    let big = run(&src, 2);
    assert_eq!(big.dimensions(), (1200, 600));
    for y in (0..600).step_by(7) {
        for x in 0..1200 {
            let s = src.get_pixel(x / 2, y / 2);
            let b = big.get_pixel(x, y);
            for c in 0..3 {
                assert!((i32::from(s[c]) - i32::from(b[c])).abs() <= 1, "({x},{y})");
            }
        }
    }
}

#[test]
fn images_smaller_than_a_tile_are_padded_and_cropped() {
    for (w, h) in [(1, 1), (5, 3), (100, 50), (255, 256)] {
        let src = pattern(w, h);
        let big = run(&src, 4);
        assert_eq!(big.dimensions(), (w * 4, h * 4));
        let (s, b) = (
            src.get_pixel(w - 1, h - 1),
            big.get_pixel(w * 4 - 1, h * 4 - 1),
        );
        assert!((i32::from(s[0]) - i32::from(b[0])).abs() <= 1);
    }
}

#[test]
fn progress_counts_every_tile() {
    let src = pattern(600, 300);
    let last = Cell::new((0, 0));
    let never = || false;
    let prog = |d: u32, t: u32| last.set((d, t));
    let hooks = TileHooks {
        cancelled: &never,
        progress: &prog,
    };
    upscale_tiled(&src, 2, &mut nearest(2), &hooks).unwrap();
    let (d, t) = last.get();
    assert_eq!(d, t);
    assert_eq!(t, tile_count(600, 300));
    assert!(t > 1);
}

#[test]
fn cancel_stops_at_the_next_tile_boundary() {
    let src = pattern(600, 600);
    let tiles = Cell::new(0);
    let cancelled = || tiles.get() >= 2;
    let none = |_: u32, _: u32| {};
    let hooks = TileHooks {
        cancelled: &cancelled,
        progress: &none,
    };
    let mut inner = nearest(2);
    let mut model = |t: &[f32]| {
        tiles.set(tiles.get() + 1);
        inner(t)
    };
    let r = upscale_tiled(&src, 2, &mut model, &hooks);
    assert!(matches!(r, Err(AppError::Cancelled)));
    assert_eq!(tiles.get(), 2, "no tile ran after the cancel");
}

#[test]
fn a_wrong_sized_model_output_is_an_error() {
    let never = || false;
    let none = |_: u32, _: u32| {};
    let hooks = TileHooks {
        cancelled: &never,
        progress: &none,
    };
    let mut bad = |_: &[f32]| Ok(vec![0.0; 10]);
    let r = upscale_tiled(&pattern(10, 10), 2, &mut bad, &hooks);
    assert!(matches!(r, Err(AppError::Inference(_))));
}

#[test]
fn custom_targets_resize_from_the_model_scale_and_alpha_survives() {
    let mut src = pattern(40, 30);
    for (x, _, p) in src.enumerate_pixels_mut() {
        if x < 10 {
            *p = Rgba([0, 0, 0, 0]);
        }
    }
    let never = || false;
    let none = |_: u32, _: u32| {};
    let hooks = TileHooks {
        cancelled: &never,
        progress: &none,
    };
    let out = upscale_ai(&src, (130, 98), 4, &mut nearest(4), &hooks).unwrap();
    assert_eq!(out.dimensions(), (130, 98));
    assert_eq!(out.get_pixel(2, 40)[3], 0);
    assert_eq!(out.get_pixel(100, 40)[3], 255);
}

#[test]
fn the_memory_guard_blocks_only_what_does_not_fit() {
    assert!(check_memory(500, Some(4000)).is_ok());
    assert!(check_memory(3300, Some(4000)).is_err());
    assert!(check_memory(99_999, None).is_ok());
    let small = memory_mb((1000, 1000), (4000, 4000), 4);
    let big = memory_mb((2000, 2000), (8000, 8000), 4);
    assert!(big > small * 3);
}

// ---- the real bundled models ------------------------------------------------------------------

fn bundled(name: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/models")
        .join(name);
    p.is_file().then_some(p)
}

fn psnr(a: &RgbaImage, b: &RgbaImage) -> f64 {
    let mut se = 0f64;
    for (p, q) in a.pixels().zip(b.pixels()) {
        for c in 0..3 {
            let d = f64::from(p[c]) - f64::from(q[c]);
            se += d * d;
        }
    }
    let mse = se / (a.width() as f64 * a.height() as f64 * 3.0);
    if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0f64 * 255.0 / mse).log10()
    }
}

/// A photo-like test picture: smooth gradients, edges, fine texture.
fn scene(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let mut c = [
            fx * 200.0 + 30.0,
            fy * 160.0 + 40.0,
            (1.0 - fx) * 180.0 + 20.0,
        ];
        let (dx, dy) = (fx - 0.5, fy - 0.5);
        if dx * dx + dy * dy < 0.06 {
            c = [230.0, 200.0 - fy * 60.0, 60.0];
        }
        let tex = (((x * 31 + y * 17) % 23) as f32 - 11.0) * 0.8;
        Rgba([
            (c[0] + tex).clamp(0.0, 255.0) as u8,
            (c[1] + tex).clamp(0.0, 255.0) as u8,
            (c[2] + tex).clamp(0.0, 255.0) as u8,
            255,
        ])
    })
}

/// Run the model once over the whole image (it accepts any size), as the reference.
fn whole_image(session: &mut ort::session::Session, src: &RgbaImage, scale: u32) -> RgbaImage {
    let (w, h) = (src.width() as usize, src.height() as usize);
    let mut input = vec![0f32; 3 * w * h];
    for (i, p) in src.pixels().enumerate() {
        for c in 0..3 {
            input[c * w * h + i] = f32::from(p[c]) / 255.0;
        }
    }
    let t = ort::value::Tensor::from_array(([1usize, 3, h, w], input)).unwrap();
    let out = session.run(ort::inputs!["input" => t]).unwrap();
    let (_, d) = out[0].try_extract_tensor::<f32>().unwrap();
    let (ow, oh) = (w * scale as usize, h * scale as usize);
    RgbaImage::from_fn(ow as u32, oh as u32, |x, y| {
        let i = y as usize * ow + x as usize;
        let q = |c: usize| (d[c * ow * oh + i].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        Rgba([q(0), q(1), q(2), 255])
    })
}

fn real_model_check(file: &str, scale: u32) {
    let Some(path) = bundled(file) else {
        eprintln!("{file} is not bundled here; skipping");
        return;
    };
    let (mut session, _) =
        crate::services::inference::open_session(&path, crate::models::dto::DevicePref::Cpu)
            .unwrap();
    // 300 x 270 needs several tiles each way.
    let src = scene(300, 270);
    let never = || false;
    let none = |_: u32, _: u32| {};
    let hooks = TileHooks {
        cancelled: &never,
        progress: &none,
    };
    let started = std::time::Instant::now();
    let tiled = {
        let mut m = |t: &[f32]| run_session(&mut session, t);
        upscale_tiled(&src, scale, &mut m, &hooks).unwrap()
    };
    let secs = started.elapsed().as_secs_f64();
    let whole = whole_image(&mut session, &src, scale);
    assert_eq!(tiled.dimensions(), whole.dimensions());
    // Tiling must agree with running the model on the whole picture (no seams, no tile borders).
    let vs_whole = psnr(&tiled, &whole);
    let lanczos = crate::services::exporter::resize_rgba(&src, tiled.dimensions()).unwrap();
    let vs_lanczos = psnr(&tiled, &lanczos);
    eprintln!(
        "{file}: {} tiles in {secs:.1}s; PSNR vs whole-image run {vs_whole:.1} dB, vs Lanczos {vs_lanczos:.1} dB",
        tile_count(300, 270)
    );
    assert!(
        vs_whole > 40.0,
        "seams: tiled differs from the whole-image run ({vs_whole} dB)"
    );
    assert!(
        vs_lanczos > 25.0,
        "the model output is not the picture ({vs_lanczos} dB)"
    );
}

#[test]
fn the_bundled_x2_model_upscales_tiled_without_seams() {
    real_model_check("realesrgan-x2.onnx", 2);
}

#[test]
fn the_bundled_x4_model_upscales_tiled_without_seams() {
    real_model_check("realesrgan-x4.onnx", 4);
}
