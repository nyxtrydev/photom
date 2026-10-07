use super::*;
use serde_json::json;

fn parse(v: Value) -> ShadowParams {
    ShadowParams::from_value(&v).unwrap()
}

#[test]
fn offsets_follow_the_light_direction() {
    let l = |angle, distance| DropLayer {
        visible: true,
        angle,
        distance,
        blur: 0.0,
        spread: 0.0,
        opacity: 1.0,
        color: DEFAULT_COLOR.into(),
    };
    let (dx, dy) = l(135.0, 100.0).offset();
    assert!((dx - 70.71).abs() < 0.01 && (dy - 70.71).abs() < 0.01);
    let near = |(dx, dy): (f64, f64), ex: f64, ey: f64| {
        assert!(
            (dx - ex).abs() < 1e-9 && (dy - ey).abs() < 1e-9,
            "{dx},{dy}"
        );
    };
    near(l(0.0, 10.0).offset(), -10.0, 0.0);
    near(l(90.0, 10.0).offset(), 0.0, 10.0);
    near(l(180.0, 10.0).offset(), 10.0, 0.0);
    near(l(270.0, 10.0).offset(), 0.0, -10.0);
}

#[test]
fn values_are_clamped_and_junk_is_repaired() {
    let p = parse(json!({
        "enabled": "yes", "autoExpand": 0,
        "layers": [
            {"type": "drop", "distance": 1e9, "blur": -5, "spread": -1e9, "opacity": 9,
             "angle": "north", "color": "red"},
            {"type": "contact", "size": 1e9, "softness": -4, "opacity": 7},
            {"type": "hologram"},
            "junk"
        ]
    }));
    assert!(!p.enabled, "only a real true enables it");
    assert!(p.auto_expand, "only a real false disables it");
    assert_eq!(p.layers.len(), 2, "unknown layer types are skipped");
    let l = p.layers[0].as_drop().unwrap();
    assert_eq!(
        (l.distance, l.blur, l.spread, l.opacity, l.angle),
        (500.0, 0.0, -50.0, 1.0, 135.0)
    );
    assert_eq!(l.color, DEFAULT_COLOR);
    let Layer::Contact(c) = &p.layers[1] else {
        panic!("contact layer")
    };
    assert_eq!((c.size, c.softness, c.opacity), (300.0, 0.0, 1.0));
}

#[test]
fn cast_values_are_clamped_and_the_vector_is_capped() {
    let p = parse(json!({"enabled": true, "groundY": 7, "layers": [
        {"type": "cast", "elevation": 0, "length": 99, "squash": 0, "falloff": 5,
         "blur": 1e3, "blurGrowth": "x", "angle": 180}
    ]}));
    assert_eq!(p.ground_y, Some(1.0));
    let Layer::Cast(c) = &p.layers[0] else {
        panic!("cast layer")
    };
    assert_eq!(
        (
            c.elevation,
            c.length,
            c.squash,
            c.falloff,
            c.blur,
            c.blur_growth
        ),
        (5.0, 2.0, 0.1, 1.0, 100.0, 40.0)
    );
    let (sx, sy) = c.vector();
    assert!((sx - 6.0).abs() < 1e-9 && sy.abs() < 1e-9, "{sx},{sy}");
    let sig = c.sigmas();
    assert_eq!(sig.len(), 4);
    assert!(
        (sig[0] - 50.0).abs() < 1e-9 && (sig[3] - 70.0).abs() < 1e-9,
        "{sig:?}"
    );
    assert_eq!(parse(json!({"layers": []})).ground_y, None);
}

#[test]
fn ground_is_the_subject_bottom_unless_set() {
    let s = Some(Frame {
        x: 0,
        y: 100,
        w: 50,
        h: 200,
    });
    let auto = parse(json!({"enabled": true, "layers": []}));
    assert_eq!(auto.ground(s, 1000), Some(300.0));
    assert_eq!(auto.ground(None, 1000), None);
    let manual = parse(json!({"enabled": true, "groundY": 0.92, "layers": []}));
    assert_eq!(manual.ground(s, 1000), Some(920.0));
}

#[test]
fn at_most_eight_layers_and_colours_are_normalised() {
    let layers: Vec<Value> = (0..30)
        .map(|_| json!({"type": "drop", "color": "#AABBCC"}))
        .collect();
    let p = parse(json!({"enabled": true, "layers": layers}));
    assert_eq!(p.layers.len(), MAX_LAYERS);
    let first = p.layers[0].as_drop().unwrap();
    assert_eq!(first.color, "#aabbcc");
    assert_eq!(first.rgb(), [0xaa, 0xbb, 0xcc]);
}

#[test]
fn nothing_usable_means_no_shadow() {
    for v in [json!(null), json!(5), json!("x"), json!([])] {
        assert!(ShadowParams::from_value(&v).is_none());
    }
}

#[test]
fn active_needs_enabled_and_a_drawable_layer() {
    let base = json!({"enabled": true, "layers": [{"type": "drop"}]});
    assert!(parse(base).active());
    assert!(!parse(json!({"enabled": false, "layers": [{"type": "drop"}]})).active());
    assert!(
        !parse(json!({"enabled": true, "layers": [{"type": "drop", "visible": false}]})).active()
    );
    assert!(!parse(json!({"enabled": true, "layers": [{"type": "drop", "opacity": 0}]})).active());
    assert!(!parse(json!({"enabled": true, "layers": []})).active());
}

/// The same cases run in `src/canvas/shadow.test.ts`: the editor preview and the export agree.
#[test]
fn canvas_bounds_match_the_shared_fixture() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/shadow_bounds.json"
    ))
    .unwrap();
    let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let src = (c["src"][0].as_i64().unwrap(), c["src"][1].as_i64().unwrap());
        let subject = c["subject"].as_object().map(|s| Frame {
            x: s["x"].as_i64().unwrap(),
            y: s["y"].as_i64().unwrap(),
            w: s["w"].as_i64().unwrap(),
            h: s["h"].as_i64().unwrap(),
        });
        let got = match ShadowParams::from_value(&c["shadow"]) {
            Some(p) => p.bounds(subject, src.0, src.1),
            None => Frame {
                x: 0,
                y: 0,
                w: src.0,
                h: src.1,
            },
        };
        let e = &c["expected"];
        let want = Frame {
            x: e["x"].as_i64().unwrap(),
            y: e["y"].as_i64().unwrap(),
            w: e["w"].as_i64().unwrap(),
            h: e["h"].as_i64().unwrap(),
        };
        assert_eq!(got, want, "{name}");
    }
}
