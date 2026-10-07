//! Golden-image tests: whole pictures (subject + shadow + background) rendered through the real
//! export pipeline and compared with committed PNGs, with a small tolerance for cross-platform
//! floating-point differences. The subjects are simple stand-ins for the products the feature is
//! for: a bottle, a shoe and a chair (thin legs).
//!
//! Regenerate after an intentional change: `UPDATE_GOLDEN=1 cargo test --lib golden`, then look at
//! the PNGs in `tests/golden/` before committing them.

use image::{GrayImage, Luma, Rgba, RgbaImage};
use serde_json::{json, Value};

use super::*;

const SIZE: u32 = 240;
/// Largest allowed per-channel difference, and the allowed mean difference.
const MAX_DIFF: u8 = 3;
const MEAN_DIFF: f64 = 0.1;

type Shape = fn(f64, f64) -> Option<[u8; 3]>;

fn rect(x: f64, y: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> bool {
    x >= x0 && x < x1 && y >= y0 && y < y1
}

fn ellipse(x: f64, y: f64, cx: f64, cy: f64, rx: f64, ry: f64) -> bool {
    ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) <= 1.0
}

/// A green glass bottle: body, shoulder and neck, with a vertical highlight.
fn bottle(x: f64, y: f64) -> Option<[u8; 3]> {
    let body = rect(x, y, 85.0, 95.0, 155.0, 205.0) || ellipse(x, y, 120.0, 95.0, 35.0, 28.0);
    let neck = rect(x, y, 108.0, 38.0, 132.0, 100.0);
    if !(body || neck) {
        return None;
    }
    let shade = 1.0 - ((x - 105.0).abs() / 60.0).min(1.0) * 0.5;
    Some([
        (40.0 * shade) as u8,
        (130.0 * shade) as u8,
        (70.0 * shade) as u8,
    ])
}

/// A brown shoe: a low body with a raised heel and a rounded toe.
fn shoe(x: f64, y: f64) -> Option<[u8; 3]> {
    let sole = rect(x, y, 30.0, 175.0, 210.0, 192.0);
    let upper = ellipse(x, y, 130.0, 170.0, 85.0, 38.0) && y < 180.0;
    let heel = rect(x, y, 30.0, 120.0, 85.0, 180.0);
    let toe = ellipse(x, y, 195.0, 178.0, 20.0, 15.0);
    if sole || upper || heel || toe {
        let c = if sole { [60, 40, 30] } else { [150, 90, 50] };
        Some(c)
    } else {
        None
    }
}

/// A wooden chair: seat, back and four thin legs.
fn chair(x: f64, y: f64) -> Option<[u8; 3]> {
    let seat = rect(x, y, 60.0, 120.0, 180.0, 135.0);
    let back = rect(x, y, 60.0, 40.0, 72.0, 135.0);
    let legs = [66.0, 90.0, 150.0, 174.0]
        .iter()
        .any(|&lx| rect(x, y, lx, 135.0, lx + 6.0, 205.0));
    if seat || back || legs {
        Some([170, 120, 70])
    } else {
        None
    }
}

fn scene(shape: Shape) -> (RgbaImage, GrayImage) {
    // A flat grey photo behind the subject; its colour must never show up in the export.
    let mut src = RgbaImage::from_pixel(SIZE, SIZE, Rgba([128, 128, 128, 255]));
    let mut mask = GrayImage::new(SIZE, SIZE);
    for y in 0..SIZE {
        for x in 0..SIZE {
            if let Some([r, g, b]) = shape(x as f64 + 0.5, y as f64 + 0.5) {
                src.put_pixel(x, y, Rgba([r, g, b, 255]));
                mask.put_pixel(x, y, Luma([255]));
            }
        }
    }
    (src, mask)
}

fn render_scene(shape: Shape, shadow: Value, white_background: bool) -> RgbaImage {
    let (src, mask) = scene(shape);
    let state = ItemState {
        refine: RefineParams {
            threshold: 0.0,
            feather: 0.0,
            edge_shift: 0.0,
        },
        shadow: Some(shadow),
        background: BackgroundState {
            kind: BgKind::Solid,
            color: "#ffffff".into(),
            ..BackgroundState::default()
        },
        ..ItemState::default()
    };
    let options = ExportOptions {
        background: if white_background {
            BackgroundMode::KeepSelected
        } else {
            BackgroundMode::Transparent
        },
        ..ExportOptions::default()
    };
    render(
        &RenderInput {
            source: &src,
            mask: Some(&mask),
            state: &state,
            bg_image: None,
        },
        &options,
    )
    .unwrap()
}

fn golden_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.png"))
}

/// Compare with the committed golden (or write it when `UPDATE_GOLDEN` is set).
fn check(name: &str, img: &RgbaImage) {
    let path = golden_path(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        img.save(&path).unwrap();
        return;
    }
    let want = image::open(&path)
        .unwrap_or_else(|e| panic!("missing golden {path:?} ({e}); run with UPDATE_GOLDEN=1"))
        .to_rgba8();
    assert_eq!(img.dimensions(), want.dimensions(), "{name}: size");
    let (mut worst, mut sum, mut count) = (0u8, 0u64, 0u64);
    for (a, b) in img.pixels().zip(want.pixels()) {
        for c in 0..4 {
            // Colour of a fully transparent pixel is meaningless.
            if c < 3 && a[3] == 0 && b[3] == 0 {
                continue;
            }
            let d = a[c].abs_diff(b[c]);
            worst = worst.max(d);
            sum += u64::from(d);
            count += 1;
        }
    }
    let mean = sum as f64 / count.max(1) as f64;
    assert!(
        worst <= MAX_DIFF && mean <= MEAN_DIFF,
        "{name}: differs from the golden (worst {worst}, mean {mean:.3}); if the change is intended run UPDATE_GOLDEN=1 and review tests/golden/{name}.png"
    );
}

fn product() -> Value {
    json!({"enabled": true, "layers": [
        {"type": "drop", "angle": 135, "distance": 2, "blur": 4, "opacity": 0.3, "color": "#2b1a10"},
        {"type": "contact", "size": 5, "softness": 1.4, "opacity": 0.55, "color": "#2b1a10"}]})
}

fn grounded() -> Value {
    json!({"enabled": true, "layers": [
        {"type": "contact", "size": 8, "softness": 2.2, "opacity": 0.65, "color": "#2b1a10"},
        {"type": "cast", "angle": 160, "elevation": 45, "length": 0.7, "squash": 0.35,
         "falloff": 0.8, "blur": 1.3, "blurGrowth": 6, "opacity": 0.35, "color": "#2b1a10"}]})
}

fn soft_studio() -> Value {
    json!({"enabled": true, "layers": [
        {"type": "reflection", "gap": 1, "fade": 22, "blur": 1, "opacity": 0.3},
        {"type": "drop", "angle": 90, "distance": 4, "blur": 19, "opacity": 0.22, "color": "#2b1a10"},
        {"type": "contact", "size": 4, "softness": 1.6, "opacity": 0.4, "color": "#2b1a10"}]})
}

#[test]
fn bottle_with_the_product_look_on_white() {
    check(
        "bottle_product_white",
        &render_scene(bottle, product(), true),
    );
}

#[test]
fn shoe_with_contact_and_cast_shadows_on_white() {
    check("shoe_grounded_white", &render_scene(shoe, grounded(), true));
}

#[test]
fn chair_with_reflection_and_soft_studio_light_on_white() {
    check(
        "chair_soft_studio_white",
        &render_scene(chair, soft_studio(), true),
    );
}

#[test]
fn chair_cast_shadow_keeps_its_thin_legs_on_a_transparent_canvas() {
    check(
        "chair_grounded_transparent",
        &render_scene(chair, grounded(), false),
    );
}

#[test]
fn bottle_in_linear_light_with_two_coloured_layers() {
    let shadow = json!({"enabled": true, "linearLight": true, "layers": [
        {"type": "drop", "angle": 120, "distance": 6, "blur": 8, "opacity": 0.5, "color": "#ff3300"},
        {"type": "drop", "angle": 200, "distance": 6, "blur": 8, "opacity": 0.5, "color": "#0033ff"}]});
    check(
        "bottle_linear_two_colours",
        &render_scene(bottle, shadow, true),
    );
}

/// Properties every golden scene must satisfy, independent of the stored pictures.
#[test]
fn golden_scenes_have_sensible_content() {
    for (shape, shadow) in [
        (bottle as Shape, product()),
        (shoe as Shape, grounded()),
        (chair as Shape, soft_studio()),
    ] {
        let (src, _) = scene(shape);
        let img = render_scene(shape, shadow, true);
        assert!(img.width() >= SIZE && img.height() >= SIZE);
        assert!(
            img.pixels().all(|p| p[3] == 255),
            "white background is opaque"
        );
        // The source photo's grey never leaks through.
        assert!(!img.pixels().any(|p| p.0 == [128, 128, 128, 255]));
        // The subject itself is untouched (its centre keeps its own colour).
        let some = (0..SIZE)
            .flat_map(|y| (0..SIZE).map(move |x| (x, y)))
            .find(|&(x, y)| src.get_pixel(x, y).0 != [128, 128, 128, 255])
            .unwrap();
        let (sx, sy) = some;
        assert_eq!(
            img.get_pixel(sx, sy).0[..3],
            src.get_pixel(sx, sy).0[..3],
            "subject pixel colour"
        );
    }
}
