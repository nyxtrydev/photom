use super::*;
use base64::Engine;
use serde_json::{json, Value};

fn colour_at(x: usize, y: usize) -> [u8; 3] {
    [((x * 5) % 256) as u8, ((y * 7) % 256) as u8, 128]
}

/// Draw a fixture case's subject: (alpha, rgba, w, h).
fn subject(c: &Value) -> (Vec<u8>, Vec<u8>, usize, usize) {
    let w = c["size"][0].as_u64().unwrap() as usize;
    let h = c["size"][1].as_u64().unwrap() as usize;
    let s = &c["shape"];
    let f = |k: &str| s[k].as_f64().unwrap();
    let mut alpha = vec![0u8; w * h];
    let mut rgba = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let inside = match s["kind"].as_str().unwrap() {
                "rect" => {
                    let (x, y) = (x as f64, y as f64);
                    x >= f("x") && x < f("x") + f("w") && y >= f("y") && y < f("y") + f("h")
                }
                _ => {
                    ((x as f64 - f("cx")) / f("rx")).powi(2)
                        + ((y as f64 - f("cy")) / f("ry")).powi(2)
                        <= 1.0
                }
            };
            let i = y * w + x;
            alpha[i] = if inside { 255 } else { 0 };
            let [r, g, b] = colour_at(x, y);
            rgba[i * 4..i * 4 + 4].copy_from_slice(&[r, g, b, alpha[i]]);
        }
    }
    (alpha, rgba, w, h)
}

/// Same steps as the editor: subject box -> frame -> ground -> render at scale 1.
fn run(params: &ShadowParams, alpha: &[u8], rgba: &[u8], w: usize, h: usize) -> (Frame, Bitmap) {
    let b = alpha_bounds(alpha, w, h, 8).expect("subject");
    let frame = params.bounds(Some(b), w as i64, h as i64);
    let ground = params.ground(Some(b), h as i64).unwrap();
    let geom = Geometry {
        x: b.x as f64,
        y: b.y as f64,
        w: b.w as f64,
        h: b.h as f64,
        ground,
    };
    let out = render(alpha, w, h, 1.0, params, frame, Some(&geom), Some(rgba)).unwrap();
    (frame, out)
}

/// The export renderer matches the editor's pixels for every layer type (within one level, to
/// allow for float rounding differences between the two languages).
#[test]
fn matches_the_editor_pixels_in_the_shared_fixture() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/shadow_render.json"
    ))
    .unwrap();
    let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let params = ShadowParams::from_value(&c["shadow"]).unwrap();
        let (alpha, rgba, w, h) = subject(&c);
        let (frame, out) = run(&params, &alpha, &rgba, w, h);
        let e = &c["frame"];
        assert_eq!(
            frame,
            Frame {
                x: e["x"].as_i64().unwrap(),
                y: e["y"].as_i64().unwrap(),
                w: e["w"].as_i64().unwrap(),
                h: e["h"].as_i64().unwrap(),
            },
            "{name}: frame"
        );
        let want = base64::engine::general_purpose::STANDARD
            .decode(c["expected"].as_str().unwrap())
            .unwrap();
        assert_eq!(out.data.len(), want.len(), "{name}: size");
        let mut worst = 0u8;
        let mut bad = 0usize;
        for (i, (a, b)) in out.data.iter().zip(&want).enumerate() {
            let d = a.abs_diff(*b);
            // Colour is meaningless where nothing is drawn.
            if i % 4 != 3 && want[i / 4 * 4 + 3] == 0 && out.data[i / 4 * 4 + 3] == 0 {
                continue;
            }
            worst = worst.max(d);
            if d > 1 {
                bad += 1;
            }
        }
        assert_eq!(
            bad, 0,
            "{name}: {bad} bytes differ by more than 1 (worst {worst})"
        );
    }
}

fn params(v: Value) -> ShadowParams {
    ShadowParams::from_value(&v).unwrap()
}

fn block(w: usize, h: usize, x0: usize, y0: usize, bw: usize, bh: usize) -> (Vec<u8>, Vec<u8>) {
    let mut alpha = vec![0u8; w * h];
    let mut rgba = vec![0u8; w * h * 4];
    for y in y0..y0 + bh {
        for x in x0..x0 + bw {
            alpha[y * w + x] = 255;
            rgba[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[200, 40, 40, 255]);
        }
    }
    (alpha, rgba)
}

fn px(b: &Bitmap, x: usize, y: usize) -> [u8; 4] {
    let i = (y * b.w + x) * 4;
    [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]]
}

#[test]
fn a_reflection_is_the_subject_flipped_below_the_ground_line() {
    let (alpha, rgba) = block(40, 80, 10, 10, 20, 30); // bottom at y = 40
    let p = params(json!({"enabled": true, "layers": [
        {"type": "reflection", "gap": 4, "fade": 20, "blur": 0, "opacity": 1}]}));
    let (_, out) = run(&p, &alpha, &rgba, 40, 80);
    // Starts `gap` below the ground line, in the subject's own colours, fading to nothing.
    assert_eq!(px(&out, 20, 40)[3], 0);
    let near = px(&out, 20, 46);
    assert!(near[3] > 230, "{near:?}");
    assert_eq!([near[0], near[1], near[2]], [200, 40, 40]);
    let far = px(&out, 20, 60);
    assert!(far[3] < near[3] / 4, "{far:?}");
    assert_eq!(px(&out, 20, 66)[3], 0); // beyond the fade length
    assert_eq!(px(&out, 5, 46)[3], 0); // beside the subject
}

#[test]
fn reflection_without_colours_or_a_ground_line_draws_nothing() {
    let (alpha, _) = block(40, 80, 10, 10, 20, 30);
    let p = params(json!({"enabled": true, "layers": [{"type": "reflection"}]}));
    let frame = Frame {
        x: 0,
        y: 0,
        w: 40,
        h: 80,
    };
    let out = render(&alpha, 40, 80, 1.0, &p, frame, None, None).unwrap();
    assert!(out.data.iter().all(|&v| v == 0));
}

#[test]
fn layers_composite_bottom_to_top() {
    let (alpha, rgba) = block(40, 40, 10, 10, 20, 20);
    let red = json!({"type": "drop", "distance": 0, "blur": 0, "opacity": 1, "color": "#ff0000"});
    let blue = json!({"type": "drop", "distance": 0, "blur": 0, "opacity": 1, "color": "#0000ff"});
    let a = run(
        &params(json!({"enabled": true, "layers": [red, blue]})),
        &alpha,
        &rgba,
        40,
        40,
    )
    .1;
    let b = run(
        &params(json!({"enabled": true, "layers": [blue, red]})),
        &alpha,
        &rgba,
        40,
        40,
    )
    .1;
    assert_eq!(px(&a, 20, 20), [0, 0, 255, 255]);
    assert_eq!(px(&b, 20, 20), [255, 0, 0, 255]);
}

#[test]
fn stacked_soft_layers_have_no_dark_fringes() {
    let (alpha, rgba) = block(60, 60, 20, 10, 20, 30);
    let p = params(json!({"enabled": true, "layers": [
        {"type": "contact", "opacity": 1, "color": "#c86432"},
        {"type": "cast", "opacity": 1, "color": "#c86432"}]}));
    let (_, out) = run(&p, &alpha, &rgba, 60, 60);
    for px in out.data.chunks(4) {
        if px[3] == 0 {
            assert_eq!(&px[..3], &[0, 0, 0]);
        } else {
            // Straight alpha: every visible pixel keeps the layer colour, however faint.
            assert!(
                (px[0] as i32 - 200).abs() <= 1 && (px[2] as i32 - 50).abs() <= 1,
                "{px:?}"
            );
        }
    }
}

#[test]
fn an_enormous_canvas_is_refused_rather_than_exhausting_memory() {
    let p = params(json!({"enabled": true, "layers": [{"type": "drop"}]}));
    let frame = Frame {
        x: 0,
        y: 0,
        w: 20_000,
        h: 20_000,
    };
    let Err(e) = render(&[0u8; 4], 2, 2, 1.0, &p, frame, None, None) else {
        panic!("should refuse");
    };
    assert!(e.to_string().contains("too large"), "{e}");
}

#[test]
fn subject_bounds_use_the_editor_threshold() {
    let mut a = vec![0u8; 100];
    a[2 * 10 + 3] = 9; // above 8
    a[7 * 10 + 6] = 8; // not above 8
    let b = alpha_bounds(&a, 10, 10, 8).unwrap();
    assert_eq!((b.x, b.y, b.w, b.h), (3, 2, 1, 1));
    assert!(alpha_bounds(&[0; 100], 10, 10, 8).is_none());
}

/// Budget check (spec: a 12 MP image in under 2 s). Ignored by default because timing depends
/// on the machine: `cargo test --lib large_shadow -- --ignored --nocapture`.
#[test]
#[ignore]
fn large_shadow_render_time_on_12_mp() {
    let (w, h) = (4000usize, 3000usize);
    let mut alpha = vec![0u8; w * h];
    let rgba = vec![180u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = ((x as f64 - 2000.0) / 900.0, (y as f64 - 1500.0) / 1100.0);
            if dx * dx + dy * dy <= 1.0 {
                alpha[y * w + x] = 255;
            }
        }
    }
    for (name, layers) in [
        (
            "drop",
            json!([{"type": "drop", "distance": 60, "blur": 80}]),
        ),
        (
            "all four",
            json!([
                {"type": "reflection"},
                {"type": "drop", "distance": 60, "blur": 80},
                {"type": "contact"},
                {"type": "cast", "blur": 20, "blurGrowth": 80}
            ]),
        ),
    ] {
        let p = params(json!({"enabled": true, "layers": layers}));
        let t = std::time::Instant::now();
        let (frame, out) = run(&p, &alpha, &rgba, w, h);
        println!(
            "{name}: {}x{} frame in {:.2}s",
            frame.w,
            frame.h,
            t.elapsed().as_secs_f64()
        );
        assert!(out.data.iter().any(|&v| v != 0));
    }
}

// ---- spec S4: blur normalisation and projection transform ----------------------------------

/// A blurred shadow keeps its total weight: blurring only moves coverage around, so a soft shadow
/// is exactly as dark overall as a hard one (when nothing is cut off at the frame edge).
#[test]
fn blur_is_normalised_it_moves_coverage_but_does_not_add_or_lose_it() {
    let (alpha, rgba) = block(120, 120, 50, 50, 20, 20);
    let sum = |blur: f64| {
        let p = params(json!({"enabled": true, "layers": [
            {"type": "drop", "distance": 0, "blur": blur, "opacity": 1, "color": "#000000"}]}));
        let (_, out) = run(&p, &alpha, &rgba, 120, 120);
        out.data.chunks(4).map(|px| px[3] as f64).sum::<f64>()
    };
    let hard = sum(0.0);
    for blur in [4.0, 12.0, 30.0] {
        let soft = sum(blur);
        assert!(
            (soft - hard).abs() / hard < 0.02,
            "blur {blur}: {soft} vs {hard}"
        );
    }
}

#[test]
fn a_uniform_mask_stays_uniform_under_blur() {
    let alpha = vec![200u8; 64 * 64];
    for sigma in [1.0, 3.5, 9.0] {
        let out = crate::services::maskops::gaussian_blur(&alpha, 64, 64, sigma);
        assert!(out.iter().all(|&v| v == 200), "sigma {sigma}");
    }
}

/// The cast projection: a pixel `h` above the ground line lands `h * (sx, sy)` away from it, so a
/// vertical pole becomes a straight line along the light direction with the vector's slope.
#[test]
fn the_cast_projection_is_a_shear_along_the_light_direction() {
    // 2 px wide pole, 30 tall, standing at x = 20 on a ground line at y = 40.
    let (w, h) = (120usize, 100usize);
    let mut alpha = vec![0u8; w * h];
    let mut rgba = vec![0u8; w * h * 4];
    for y in 10..40 {
        for x in 20..22 {
            alpha[y * w + x] = 255;
            rgba[(y * w + x) * 4 + 3] = 255;
        }
    }
    let p = params(json!({"enabled": true, "layers": [
        {"type": "cast", "angle": 150, "elevation": 30, "length": 0.5, "squash": 0.5,
         "falloff": 0, "blur": 0, "blurGrowth": 0, "opacity": 1, "color": "#000000"}]}));
    let Layer::Cast(l) = &p.layers[0] else {
        panic!("cast")
    };
    let (sx, sy) = l.vector();
    // length / tan(30 deg) = 0.866; light from 150 deg: shadow runs right and toward the viewer
    assert!(
        (sx - 0.866 * 0.866).abs() < 1e-3 && (sy - 0.866 * 0.5 * 0.5).abs() < 1e-3,
        "{sx} {sy}"
    );
    let (_, out) = run(&p, &alpha, &rgba, w, h);
    // Every height along the pole lands on the sheared line; none is missing.
    for hh in (1..30).step_by(3) {
        let x = (20.0 + sx * hh as f64 + 0.5).round() as usize;
        let y = (40.0 + sy * hh as f64).round() as usize;
        assert!(px(&out, x, y)[3] > 200, "h = {hh} at ({x}, {y})");
    }
    // The tip is the farthest point from the pole base; nothing lies beyond it.
    let tip_x = (20.0 + sx * 30.0).round() as usize + 3;
    assert_eq!(
        px(&out, tip_x.min(w - 1), (40.0 + sy * 30.0) as usize + 4)[3],
        0
    );
}

/// Premultiplied-style compositing: faint overlapping layers must not darken the colour. Two
/// 10 % layers of the same orange stay orange, only more opaque.
#[test]
fn overlapping_faint_layers_keep_their_colour() {
    let (alpha, rgba) = block(40, 40, 10, 10, 20, 20);
    let layer =
        json!({"type": "drop", "distance": 0, "blur": 0, "opacity": 0.1, "color": "#e08020"});
    let p = params(json!({"enabled": true, "layers": [layer, layer, layer]}));
    let (_, out) = run(&p, &alpha, &rgba, 40, 40);
    let c = px(&out, 20, 20);
    assert!(c[3] > 60 && c[3] < 80, "{c:?}"); // 1 - 0.9^3 = 27 % of 255
    assert_eq!([c[0], c[1], c[2]], [0xe0, 0x80, 0x20]);
}
