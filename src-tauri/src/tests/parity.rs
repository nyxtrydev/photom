//! The Rust export maths must agree with the TypeScript preview maths. The fixture is produced by
//! `src/canvas/parity.test.ts`.

use serde::Deserialize;

use crate::services::brush::{replay_strokes, Stroke};
use crate::services::maskops::{compose_final, compute_refined, RefineParams};

#[derive(Deserialize)]
struct Case {
    name: String,
    params: RefineParams,
    scale: f64,
    strokes: Vec<Stroke>,
    expected: Vec<u8>,
}

#[derive(Deserialize)]
struct Fixture {
    width: usize,
    height: usize,
    base: Vec<u8>,
    cases: Vec<Case>,
}

#[test]
fn rust_export_maths_matches_the_typescript_preview_maths() {
    let raw = include_str!("../../tests/fixtures/mask_parity.json");
    let f: Fixture = serde_json::from_str(raw).expect("fixture parses");
    assert_eq!(f.base.len(), f.width * f.height);

    for c in &f.cases {
        let refined = compute_refined(&f.base, f.width, f.height, c.params, c.scale);
        let mut delta = vec![0i16; f.width * f.height];
        replay_strokes(&mut delta, f.width, f.height, c.scale, &c.strokes);
        let mut out = vec![0u8; f.width * f.height];
        compose_final(&refined, &delta, &mut out);

        let worst = out
            .iter()
            .zip(&c.expected)
            .map(|(a, b)| (*a as i32 - *b as i32).abs())
            .max()
            .unwrap_or(0);
        let differing = out.iter().zip(&c.expected).filter(|(a, b)| a != b).count();
        // Identical algorithms: allow no pixel to be off by more than 1 (float rounding only).
        assert!(
            worst <= 1,
            "case '{}': max difference {worst} ({differing} pixels differ)",
            c.name
        );
        assert!(
            differing * 100 < out.len(),
            "case '{}': too many differing pixels ({differing})",
            c.name
        );
    }
}
