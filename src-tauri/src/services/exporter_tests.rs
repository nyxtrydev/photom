use image::{GrayImage, Luma, Rgb, RgbImage};

use super::*;
use crate::models::dto::ImageMeta;
use crate::services::brush::BrushMode;

/// Source 100x80 (orange, opaque) with a rectangular subject mask.
fn fixture(mask_rect: Option<(u32, u32, u32, u32)>) -> (RgbaImage, Option<GrayImage>) {
    let src = RgbaImage::from_pixel(100, 80, Rgba([220, 110, 30, 255]));
    let mask = mask_rect.map(|(x0, y0, x1, y1)| {
        GrayImage::from_fn(100, 80, |x, y| {
            Luma([if (x0..x1).contains(&x) && (y0..y1).contains(&y) {
                255
            } else {
                0
            }])
        })
    });
    (src, mask)
}

fn no_refine() -> ItemState {
    ItemState {
        refine: RefineParams {
            threshold: 0.0,
            feather: 0.0,
            edge_shift: 0.0,
        },
        ..ItemState::default()
    }
}

fn render_with(
    state: &ItemState,
    mask: Option<&GrayImage>,
    src: &RgbaImage,
    opts: &ExportOptions,
) -> AppResult<RgbaImage> {
    render(
        &RenderInput {
            source: src,
            mask,
            state,
            bg_image: None,
        },
        opts,
    )
}

#[test]
fn transparent_export_has_alpha_only_where_the_subject_is() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let out = render_with(&no_refine(), mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    assert_eq!(out.dimensions(), (100, 80));
    assert_eq!(out.get_pixel(40, 30)[3], 255);
    assert_eq!(out.get_pixel(40, 30).0[..3], [220, 110, 30]); // original colour preserved
    assert_eq!(out.get_pixel(5, 5)[3], 0);
}

#[test]
fn crop_padding_is_exact() {
    let (src, mask) = fixture(Some((30, 20, 50, 40))); // 20 x 20 subject
    let opts = ExportOptions {
        crop: CropOptions {
            enabled: true,
            padding: 7,
        },
        ..ExportOptions::default()
    };
    let out = render_with(&no_refine(), mask.as_ref(), &src, &opts).unwrap();
    assert_eq!(out.dimensions(), (20 + 14, 20 + 14));
    // Subject begins exactly `padding` pixels in from every side.
    assert_eq!(out.get_pixel(6, 17)[3], 0);
    assert_eq!(out.get_pixel(7, 17)[3], 255);
    assert_eq!(out.get_pixel(26, 17)[3], 255);
    assert_eq!(out.get_pixel(27, 17)[3], 0);
    assert_eq!(out.get_pixel(17, 6)[3], 0);
    assert_eq!(out.get_pixel(17, 7)[3], 255);
}

#[test]
fn padding_stays_exact_even_when_the_subject_touches_the_image_edge() {
    let (src, mask) = fixture(Some((0, 0, 10, 10)));
    let opts = ExportOptions {
        crop: CropOptions {
            enabled: true,
            padding: 5,
        },
        ..ExportOptions::default()
    };
    let out = render_with(&no_refine(), mask.as_ref(), &src, &opts).unwrap();
    assert_eq!(out.dimensions(), (20, 20));
    assert_eq!(out.get_pixel(4, 10)[3], 0); // extended canvas is transparent
    assert_eq!(out.get_pixel(5, 5)[3], 255); // subject starts at the padding offset
}

#[test]
fn crop_without_a_subject_falls_back_to_the_full_image() {
    let (src, mask) = fixture(None);
    let empty = GrayImage::new(100, 80);
    let _ = mask;
    let opts = ExportOptions {
        crop: CropOptions {
            enabled: true,
            padding: 3,
        },
        ..ExportOptions::default()
    };
    let out = render_with(&no_refine(), Some(&empty), &src, &opts).unwrap();
    assert_eq!(out.dimensions(), (100, 80));
}

#[test]
fn custom_size_is_exact_and_keeps_alpha_clean_at_the_edges() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let opts = ExportOptions {
        size: SizeOptions {
            mode: SizeMode::Custom,
            width: 333,
            height: 71,
            max_side: None,
        },
        ..ExportOptions::default()
    };
    let out = render_with(&no_refine(), mask.as_ref(), &src, &opts).unwrap();
    assert_eq!(out.dimensions(), (333, 71));
    // Premultiplied resize: opaque subject pixels keep the source colour (no dark fringe/bleed).
    let c = out.get_pixel(333 * 40 / 100, 71 * 30 / 80);
    assert_eq!(c[3], 255);
    assert!(
        (c[0] as i32 - 220).abs() <= 2
            && (c[1] as i32 - 110).abs() <= 2
            && (c[2] as i32 - 30).abs() <= 2
    );
}

#[test]
fn max_side_downsizes_but_never_upscales() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let cap = |m| ExportOptions {
        size: SizeOptions {
            mode: SizeMode::Original,
            width: 0,
            height: 0,
            max_side: Some(m),
        },
        ..ExportOptions::default()
    };
    assert_eq!(
        render_with(&no_refine(), mask.as_ref(), &src, &cap(50))
            .unwrap()
            .dimensions(),
        (50, 40)
    );
    assert_eq!(
        render_with(&no_refine(), mask.as_ref(), &src, &cap(5000))
            .unwrap()
            .dimensions(),
        (100, 80)
    );
}

#[test]
fn crop_then_custom_size_gives_the_requested_dimensions() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let opts = ExportOptions {
        crop: CropOptions {
            enabled: true,
            padding: 10,
        },
        size: SizeOptions {
            mode: SizeMode::Custom,
            width: 64,
            height: 64,
            max_side: None,
        },
        ..ExportOptions::default()
    };
    assert_eq!(
        render_with(&no_refine(), mask.as_ref(), &src, &opts)
            .unwrap()
            .dimensions(),
        (64, 64)
    );
}

#[test]
fn rejects_zero_and_absurd_sizes() {
    for (w, h) in [(0, 10), (10, 0), (40_000, 10), (30_000, 30_000)] {
        let size = SizeOptions {
            mode: SizeMode::Custom,
            width: w,
            height: h,
            max_side: None,
        };
        assert_eq!(
            target_size(&size, (10, 10)).unwrap_err().code(),
            "InvalidInput",
            "{w}x{h}"
        );
    }
}

#[test]
fn keep_selected_background_composites_a_solid_colour() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let mut state = no_refine();
    state.background = BackgroundState {
        kind: BgKind::Solid,
        color: "#00ff00".into(),
        ..BackgroundState::default()
    };
    let keep = ExportOptions {
        background: BackgroundMode::KeepSelected,
        ..ExportOptions::default()
    };
    let out = render_with(&state, mask.as_ref(), &src, &keep).unwrap();
    assert_eq!(out.get_pixel(5, 5).0, [0, 255, 0, 255]);
    assert_eq!(out.get_pixel(40, 30).0, [220, 110, 30, 255]);

    // "Transparent" ignores the chosen background.
    let transparent = render_with(&state, mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    assert_eq!(transparent.get_pixel(5, 5)[3], 0);
}

#[test]
fn keep_selected_with_a_background_picture_uses_the_fit_mode() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let pic = RgbImage::from_fn(10, 10, |x, _| {
        if x < 5 {
            Rgb([255, 0, 0])
        } else {
            Rgb([0, 0, 255])
        }
    });
    let mut state = no_refine();
    state.background = BackgroundState {
        kind: BgKind::Image,
        fit: FitMode::Stretch,
        image: Some(BgImageRef {
            source_path: "x".into(),
        }),
        ..BackgroundState::default()
    };
    let keep = ExportOptions {
        background: BackgroundMode::KeepSelected,
        ..ExportOptions::default()
    };
    let out = render(
        &RenderInput {
            source: &src,
            mask: mask.as_ref(),
            state: &state,
            bg_image: Some(&pic),
        },
        &keep,
    )
    .unwrap();
    assert_eq!(out.get_pixel(5, 70).0, [255, 0, 0, 255]);
    assert_eq!(out.get_pixel(95, 70).0, [0, 0, 255, 255]);
}

#[test]
fn contain_leaves_transparent_margins() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let pic = RgbImage::from_pixel(10, 40, Rgb([9, 9, 9])); // tall picture in a wide canvas
    let mut state = no_refine();
    state.background = BackgroundState {
        kind: BgKind::Image,
        fit: FitMode::Contain,
        image: Some(BgImageRef::default()),
        ..BackgroundState::default()
    };
    let keep = ExportOptions {
        background: BackgroundMode::KeepSelected,
        ..ExportOptions::default()
    };
    let out = render(
        &RenderInput {
            source: &src,
            mask: mask.as_ref(),
            state: &state,
            bg_image: Some(&pic),
        },
        &keep,
    )
    .unwrap();
    assert_eq!(out.get_pixel(2, 70)[3], 0); // left margin
    assert_eq!(out.get_pixel(50, 70).0, [9, 9, 9, 255]); // centre column holds the picture
}

#[test]
fn refine_and_brush_edits_reach_the_exported_pixels() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let mut state = no_refine();
    state.strokes = vec![Stroke {
        mode: BrushMode::Erase,
        size: 12.0,
        hardness: 100.0,
        points: vec![[40.0, 30.0, 1.0]],
    }];
    let out = render_with(&state, mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    assert_eq!(out.get_pixel(40, 30)[3], 0); // erased
    assert_eq!(out.get_pixel(32, 22)[3], 255); // elsewhere kept

    let mut grown = no_refine();
    grown.refine.edge_shift = 4.0;
    let out = render_with(&grown, mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    assert_eq!(out.get_pixel(27, 30)[3], 255); // 3 px outside the original edge
}

#[test]
fn source_alpha_is_respected() {
    let mut src = RgbaImage::from_pixel(20, 20, Rgba([1, 2, 3, 255]));
    src.put_pixel(10, 10, Rgba([1, 2, 3, 0])); // a hole in the original
    let mask = GrayImage::from_pixel(20, 20, Luma([255]));
    let out = render_with(&no_refine(), Some(&mask), &src, &ExportOptions::default()).unwrap();
    assert_eq!(out.get_pixel(10, 10)[3], 0);
    assert_eq!(out.get_pixel(9, 10)[3], 255);
}

#[test]
fn exporting_without_a_mask_is_a_clear_error() {
    let (src, _) = fixture(None);
    let e = render_with(&no_refine(), None, &src, &ExportOptions::default()).unwrap_err();
    assert_eq!(e.code(), "ExportFailed");
    assert!(e.to_string().contains("Remove the background"));
}

#[test]
fn png_roundtrip_keeps_alpha_and_opaque_images_are_stored_as_rgb() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let out = render_with(&no_refine(), mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    let png = encode_png(&out, 6).unwrap();
    let back = image::load_from_memory(&png).unwrap();
    assert!(back.color().has_alpha());
    assert_eq!(back.to_rgba8().get_pixel(5, 5)[3], 0);

    let opaque = RgbaImage::from_pixel(8, 8, Rgba([1, 2, 3, 255]));
    assert!(!image::load_from_memory(&encode_png(&opaque, 6).unwrap())
        .unwrap()
        .color()
        .has_alpha());
}

#[test]
fn higher_compression_is_not_larger() {
    let img = RgbaImage::from_fn(200, 200, |x, y| {
        Rgba([(x % 7) as u8 * 30, (y % 5) as u8 * 40, 9, 255])
    });
    let fast = encode_png(&img, 0).unwrap().len();
    let best = encode_png(&img, 9).unwrap().len();
    assert!(best < fast, "level 9 ({best}) should beat level 0 ({fast})");
}

#[test]
fn filename_templates_expand_and_stay_safe() {
    let ctx = |name| TemplateContext {
        name,
        index: 3,
        total: 40,
        date: "2026-10-05",
    };
    assert_eq!(
        expand_template("{name}-photom.png", &ctx("dog")),
        "dog-photom.png"
    );
    assert_eq!(
        expand_template("{index}_{name}_{date}", &ctx("dog")),
        "03_dog_2026-10-05.png"
    );
    assert_eq!(expand_template("", &ctx("dog")), "dog-photom.png");
    assert_eq!(expand_template("{name}.PNG", &ctx("dog")), "dog.PNG");
    // Path separators and reserved characters cannot escape the folder.
    let escaped = expand_template("../../{name}", &ctx("a/b"));
    assert_eq!(escaped, "_.._a_b.png");
    assert!(!escaped.contains(['/', '\\']));
    assert!(!expand_template("a<b>:c?.png", &ctx("x")).contains(['<', '>', ':', '?']));
    // Windows device names are neutralised; unicode and spaces survive.
    assert_eq!(expand_template("CON", &ctx("x")), "_CON.png");
    assert_eq!(
        expand_template("{name}", &ctx("héllo wörld 猫")),
        "héllo wörld 猫.png"
    );
    assert!(expand_template(&"x".repeat(500), &ctx("x")).chars().count() <= 150);
}

#[test]
fn files_are_never_overwritten_they_get_a_numeric_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let a = write_unique(dir.path(), "dog.png", b"one").unwrap();
    let b = write_unique(dir.path(), "dog.png", b"two").unwrap();
    let c = write_unique(dir.path(), "dog.png", b"three").unwrap();
    assert_eq!(a.file_name().unwrap(), "dog.png");
    assert_eq!(b.file_name().unwrap(), "dog (2).png");
    assert_eq!(c.file_name().unwrap(), "dog (3).png");
    assert_eq!(fs::read(&a).unwrap(), b"one"); // original untouched
    assert_eq!(fs::read(&c).unwrap(), b"three");
}

#[test]
fn concurrent_exports_to_the_same_name_do_not_clobber_each_other() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let p = path.clone();
            std::thread::spawn(move || {
                write_unique(&p, "same.png", format!("{i}").as_bytes()).unwrap()
            })
        })
        .collect();
    let mut outs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    outs.sort();
    outs.dedup();
    assert_eq!(outs.len(), 8, "every writer must get its own file");
    assert_eq!(fs::read_dir(&path).unwrap().count(), 8);
}

#[test]
fn folder_validation() {
    assert_eq!(ensure_folder("").unwrap_err().code(), "InvalidInput");
    assert_eq!(
        ensure_folder("relative/dir").unwrap_err().code(),
        "InvalidInput"
    );
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("a").join("b é");
    assert!(ensure_folder(&nested.display().to_string())
        .unwrap()
        .is_dir()); // created, unicode + spaces
    let file = dir.path().join("f.txt");
    fs::write(&file, b"x").unwrap();
    assert!(ensure_folder(&file.display().to_string()).is_err());
}

#[cfg(unix)]
#[test]
fn read_only_folder_gives_a_clear_permission_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let r = write_unique(dir.path(), "x.png", b"data");
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    // Running as root bypasses permissions; only assert when the write was actually refused.
    if let Err(e) = r {
        assert_eq!(e.code(), "Permission");
        assert!(e.to_string().contains("cannot write"));
    }
}

#[test]
fn full_item_export_writes_a_png_from_files_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let src_path = dir.path().join("photo é.png");
    RgbImage::from_pixel(100, 80, Rgb([220, 110, 30]))
        .save(&src_path)
        .unwrap();
    let mask_path = dir.path().join("mask.png");
    GrayImage::from_fn(100, 80, |x, y| {
        Luma([if (30..50).contains(&x) && (20..40).contains(&y) {
            255
        } else {
            0
        }])
    })
    .save(&mask_path)
    .unwrap();
    let rec = ImageRecord {
        meta: ImageMeta {
            id: "a".into(),
            path: src_path.display().to_string(),
            name: "photo é.png".into(),
            width: 100,
            height: 80,
            format: "png".into(),
            thumbnail_path: String::new(),
        },
        source: src_path,
        mask_path: Some(mask_path),
    };
    let opts = ExportOptions {
        folder: dir.path().join("out").display().to_string(),
        crop: CropOptions {
            enabled: true,
            padding: 4,
        },
        ..ExportOptions::default()
    };
    let state = no_refine();
    let req = |index| ItemRequest {
        rec: &rec,
        state: &state,
        options: &opts,
        index,
        total: 2,
        date: "2026-10-05",
        pixel_limit: 100_000_000,
    };
    let (a, _) = export_item(&req(1)).unwrap();
    let (b, _) = export_item(&req(2)).unwrap();
    assert!(a.output_path.ends_with("photo é-photom.png"));
    assert!(b.output_path.ends_with("photo é-photom (2).png")); // second run never overwrites
    assert_eq!((a.width, a.height), (28, 28));
    let back = image::open(&a.output_path).unwrap();
    assert_eq!((back.width(), back.height()), (28, 28));
    assert!(back.color().has_alpha());
}

// ---- shadows ------------------------------------------------------------------------------

fn shadow_state(shadow: serde_json::Value) -> ItemState {
    ItemState {
        shadow: Some(shadow),
        ..no_refine()
    }
}

/// A black, hard-edged drop shadow thrown 28 px down and right (40 px at 135 degrees).
fn hard_drop() -> serde_json::Value {
    serde_json::json!({"enabled": true, "autoExpand": true, "layers": [
        {"type": "drop", "angle": 135, "distance": 40, "blur": 0, "opacity": 1, "color": "#000000"}]})
}

/// Subject in the lower right corner, so its shadow falls off the image.
fn corner() -> (RgbaImage, Option<GrayImage>) {
    fixture(Some((80, 60, 100, 80)))
}

fn layers(
    state: &ItemState,
    mask: Option<&GrayImage>,
    src: &RgbaImage,
    opts: &ExportOptions,
) -> Rendered {
    render_layers(
        &RenderInput {
            source: src,
            mask,
            state,
            bg_image: None,
        },
        opts,
    )
    .unwrap()
}

#[test]
fn an_enabled_shadow_is_baked_in_under_the_subject_and_grows_the_canvas() {
    let (src, mask) = corner();
    let out = render_with(
        &shadow_state(hard_drop()),
        mask.as_ref(),
        &src,
        &ExportOptions::default(),
    )
    .unwrap();
    assert_eq!(out.dimensions(), (129, 109)); // 100 + 28.3 and 80 + 28.3, rounded outward
    assert_eq!(out.get_pixel(90, 70).0, [220, 110, 30, 255]); // subject untouched, on top
    assert_eq!(out.get_pixel(115, 95).0, [0, 0, 0, 255]); // the shadow, past the image edge
    assert_eq!(out.get_pixel(60, 20)[3], 0); // empty elsewhere
}

#[test]
fn without_a_shadow_nothing_changes() {
    let (src, mask) = corner();
    for state in [
        no_refine(),
        shadow_state(serde_json::json!({"enabled": false, "layers": [{"type": "drop"}]})),
        shadow_state(serde_json::json!({"enabled": true, "layers": []})),
        shadow_state(serde_json::json!("junk")),
    ] {
        let r = layers(&state, mask.as_ref(), &src, &ExportOptions::default());
        assert_eq!(r.image.dimensions(), (100, 80));
        assert!(r.shadow.is_none());
    }
}

#[test]
fn include_shadow_off_keeps_the_canvas_but_leaves_the_shadow_out() {
    let (src, mask) = corner();
    let opts = ExportOptions {
        include_shadow: false,
        ..ExportOptions::default()
    };
    let r = layers(&shadow_state(hard_drop()), mask.as_ref(), &src, &opts);
    // The shadow is off, and nothing else was asked for: exactly the old output.
    assert_eq!(r.image.dimensions(), (100, 80));
    assert!(r.shadow.is_none());
}

#[test]
fn a_separate_shadow_layer_lines_up_with_the_main_picture() {
    let (src, mask) = corner();
    let opts = ExportOptions {
        include_shadow: false,
        shadow_layer: true,
        ..ExportOptions::default()
    };
    let r = layers(&shadow_state(hard_drop()), mask.as_ref(), &src, &opts);
    let shadow = r.shadow.expect("a separate layer");
    assert_eq!(shadow.dimensions(), r.image.dimensions());
    assert_eq!(r.image.dimensions(), (129, 109));
    assert_eq!(r.image.get_pixel(115, 95)[3], 0); // not baked into the picture
    assert_eq!(shadow.get_pixel(115, 95).0, [0, 0, 0, 255]); // it is on the layer
    assert_eq!(shadow.get_pixel(90, 70)[3], 0); // the layer holds the shadow only
    assert_eq!(r.image.get_pixel(90, 70)[3], 255);

    // Both at once: baked in AND written separately.
    let both = ExportOptions {
        shadow_layer: true,
        ..ExportOptions::default()
    };
    let r = layers(&shadow_state(hard_drop()), mask.as_ref(), &src, &both);
    assert_eq!(r.image.get_pixel(115, 95).0, [0, 0, 0, 255]);
    assert!(r.shadow.is_some());
}

#[test]
fn the_shadow_layer_is_not_given_the_background() {
    let (src, mask) = corner();
    let mut state = shadow_state(hard_drop());
    state.background = BackgroundState {
        kind: BgKind::Solid,
        color: "#ffffff".into(),
        ..BackgroundState::default()
    };
    let opts = ExportOptions {
        background: BackgroundMode::KeepSelected,
        shadow_layer: true,
        ..ExportOptions::default()
    };
    let r = layers(&state, mask.as_ref(), &src, &opts);
    assert_eq!(r.image.get_pixel(5, 5).0, [255, 255, 255, 255]);
    assert_eq!(r.shadow.unwrap().get_pixel(5, 5)[3], 0);
}

#[test]
fn crop_to_subject_keeps_the_shadow() {
    let (src, mask) = corner();
    let opts = ExportOptions {
        crop: CropOptions {
            enabled: true,
            padding: 0,
        },
        ..ExportOptions::default()
    };
    let with = layers(&shadow_state(hard_drop()), mask.as_ref(), &src, &opts);
    // subject x 80..99, shadow to x 127 and y 107: a 48 x 48 box starting at (80, 60)
    assert_eq!(with.image.dimensions(), (48, 48));
    assert_eq!(with.image.get_pixel(0, 0).0, [220, 110, 30, 255]);
    assert_eq!(with.image.get_pixel(40, 40).0, [0, 0, 0, 255]);
    let without = layers(&no_refine(), mask.as_ref(), &src, &opts);
    assert_eq!(without.image.dimensions(), (20, 20));
}

#[test]
fn custom_size_scales_the_shadow_with_the_picture() {
    let (src, mask) = corner();
    let opts = ExportOptions {
        size: SizeOptions {
            mode: SizeMode::Custom,
            width: 258,
            height: 218,
            max_side: None,
        },
        ..ExportOptions::default()
    };
    let out = layers(&shadow_state(hard_drop()), mask.as_ref(), &src, &opts).image;
    assert_eq!(out.dimensions(), (258, 218));
    assert_eq!(out.get_pixel(230, 190).0, [0, 0, 0, 255]); // (115, 95) at double size
}

#[test]
fn a_reflection_carries_the_subjects_own_colours() {
    let (src, mask) = fixture(Some((30, 20, 50, 40)));
    let state = shadow_state(serde_json::json!({"enabled": true, "layers": [
        {"type": "reflection", "gap": 0, "fade": 20, "blur": 0, "opacity": 1}]}));
    let out = render_with(&state, mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    let p = out.get_pixel(40, 42);
    assert_eq!(&p.0[..3], &[220, 110, 30]);
    assert!(p[3] > 150, "{p:?}");
}

#[test]
fn the_shadow_file_name_follows_the_picture() {
    assert_eq!(shadow_file_name("a-photom.png"), "a-photom-shadow.png");
    assert_eq!(
        shadow_file_name("a-photom (2).png"),
        "a-photom (2)-shadow.png"
    );
    assert_eq!(shadow_file_name("noext"), "noext-shadow.png");
}

#[test]
fn exporting_an_item_writes_the_shadow_next_to_it_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let src_path = dir.path().join("shoe.png");
    RgbImage::from_pixel(100, 80, Rgb([220, 110, 30]))
        .save(&src_path)
        .unwrap();
    let mask_path = dir.path().join("mask.png");
    GrayImage::from_fn(100, 80, |x, y| {
        Luma([if x >= 80 && y >= 60 { 255 } else { 0 }])
    })
    .save(&mask_path)
    .unwrap();
    let rec = ImageRecord {
        meta: ImageMeta {
            id: "a".into(),
            path: src_path.display().to_string(),
            name: "shoe.png".into(),
            width: 100,
            height: 80,
            format: "png".into(),
            thumbnail_path: String::new(),
        },
        source: src_path,
        mask_path: Some(mask_path),
    };
    let opts = ExportOptions {
        folder: dir.path().join("out").display().to_string(),
        shadow_layer: true,
        ..ExportOptions::default()
    };
    let state = shadow_state(hard_drop());
    let req = || ItemRequest {
        rec: &rec,
        state: &state,
        options: &opts,
        index: 1,
        total: 1,
        date: "2026-10-05",
        pixel_limit: 100_000_000,
    };
    let (a, _) = export_item(&req()).unwrap();
    assert!(a.output_path.ends_with("shoe-photom.png"));
    assert!(a
        .shadow_path
        .as_deref()
        .unwrap()
        .ends_with("shoe-photom-shadow.png"));
    let (b, _) = export_item(&req()).unwrap();
    assert!(b.output_path.ends_with("shoe-photom (2).png"));
    assert!(b
        .shadow_path
        .as_deref()
        .unwrap()
        .ends_with("shoe-photom (2)-shadow.png"));
    let layer = image::open(a.shadow_path.unwrap()).unwrap().to_rgba8();
    assert_eq!(layer.dimensions(), (a.width, a.height));
    assert_eq!(layer.get_pixel(90, 70)[3], 0);
    assert_eq!(layer.get_pixel(115, 95).0, [0, 0, 0, 255]);
}

// ---- apply-to-many check ------------------------------------------------------------------

fn record_on_disk(dir: &std::path::Path, mask: Option<GrayImage>) -> ImageRecord {
    let src_path = dir.join("p.png");
    RgbImage::from_pixel(100, 80, Rgb([220, 110, 30]))
        .save(&src_path)
        .unwrap();
    let mask_path = mask.map(|m| {
        let p = dir.join("m.png");
        m.save(&p).unwrap();
        p
    });
    ImageRecord {
        meta: ImageMeta {
            id: "p".into(),
            path: src_path.display().to_string(),
            name: "p.png".into(),
            width: 100,
            height: 80,
            format: "png".into(),
            thumbnail_path: String::new(),
        },
        source: src_path,
        mask_path,
    }
}

fn corner_mask() -> GrayImage {
    GrayImage::from_fn(100, 80, |x, y| {
        Luma([if x >= 80 && y >= 60 { 255 } else { 0 }])
    })
}

#[test]
fn checking_a_shadow_reports_the_canvas_it_needs_without_rendering() {
    let dir = tempfile::tempdir().unwrap();
    let rec = record_on_disk(dir.path(), Some(corner_mask()));
    let c = shadow_check(&rec, &shadow_state(hard_drop()), 100_000_000).unwrap();
    assert_eq!((c.frame.w, c.frame.h), (129, 109));
    assert_eq!((c.frame.x, c.frame.y), (0, 0));
    assert_eq!(c.ground, 80.0); // the subject's lowest pixel
    assert_eq!(c.id, "p");
}

#[test]
fn checking_fails_clearly_without_a_cutout_subject_or_shadow() {
    let dir = tempfile::tempdir().unwrap();
    let none = record_on_disk(dir.path(), None);
    let err = shadow_check(&none, &shadow_state(hard_drop()), 100_000_000).unwrap_err();
    assert!(err.to_string().contains("Remove the background"), "{err}");

    let dir2 = tempfile::tempdir().unwrap();
    let empty = record_on_disk(dir2.path(), Some(GrayImage::new(100, 80)));
    let err = shadow_check(&empty, &shadow_state(hard_drop()), 100_000_000).unwrap_err();
    assert!(err.to_string().contains("No subject"), "{err}");

    let dir3 = tempfile::tempdir().unwrap();
    let ok = record_on_disk(dir3.path(), Some(corner_mask()));
    let disabled =
        shadow_state(serde_json::json!({"enabled": false, "layers": [{"type": "drop"}]}));
    let err = shadow_check(&ok, &disabled, 100_000_000).unwrap_err();
    assert!(err.to_string().contains("no shadow"), "{err}");
    assert!(shadow_check(&ok, &no_refine(), 100_000_000).is_err());
}

// ---- rendering from a kept upscale ------------------------------------------------------------

fn nearest_up(img: &RgbaImage, k: u32) -> RgbaImage {
    RgbaImage::from_fn(img.width() * k, img.height() * k, |x, y| {
        *img.get_pixel(x / k, y / k)
    })
}

fn mean_diff(a: &RgbaImage, b: &RgbaImage) -> f64 {
    assert_eq!(a.dimensions(), b.dimensions());
    let mut sum = 0u64;
    for (p, q) in a.pixels().zip(b.pixels()) {
        for c in 0..4 {
            sum += u64::from(p[c].abs_diff(q[c]));
        }
    }
    sum as f64 / (a.width() as f64 * a.height() as f64 * 4.0)
}

/// An upscaled source with `detail_scale = k` must come out like the original at k times the size:
/// the shadow, the feather and the brush edits all keep their look.
#[test]
fn rendering_from_an_upscaled_source_matches_the_original_at_k_times_the_size() {
    let (src, mask) = corner();
    let mask = mask.unwrap();
    let state = ItemState {
        refine: RefineParams {
            threshold: 50.0,
            feather: 2.0,
            edge_shift: 1.0,
        },
        strokes: vec![crate::services::brush::Stroke {
            mode: BrushMode::Erase,
            size: 12.0,
            hardness: 100.0,
            points: vec![[90.0, 70.0, 1.0], [95.0, 72.0, 1.0]],
        }],
        shadow: Some(hard_drop()),
        ..ItemState::default()
    };
    let opts = ExportOptions::default();
    let base = render_with(&state, Some(&mask), &src, &opts).unwrap();

    for k in [2u32, 4] {
        let big_src = nearest_up(&src, k);
        let big_mask = GrayImage::from_fn(mask.width() * k, mask.height() * k, |x, y| {
            *mask.get_pixel(x / k, y / k)
        });
        let big_state = ItemState {
            detail_scale: f64::from(k),
            ..state.clone()
        };
        let big = render_with(&big_state, Some(&big_mask), &big_src, &opts).unwrap();
        // Canvas: within a pixel or two of k times the original (rounding of the outward growth).
        assert!(
            big.width().abs_diff(base.width() * k) <= k
                && big.height().abs_diff(base.height() * k) <= k,
            "{k}x: {:?} vs {:?}",
            big.dimensions(),
            base.dimensions()
        );
        let want = nearest_up(&base, k);
        let big = image::imageops::crop_imm(
            &big,
            0,
            0,
            want.width().min(big.width()),
            want.height().min(big.height()),
        )
        .to_image();
        let want = image::imageops::crop_imm(&want, 0, 0, big.width(), big.height()).to_image();
        let d = mean_diff(&big, &want);
        assert!(d < 4.0, "{k}x differs from the original by {d} per channel");
        // The check is not vacuous: without the scale the same inputs come out clearly different.
        let unscaled = render_with(&state, Some(&big_mask), &big_src, &opts).unwrap();
        assert!(
            unscaled.dimensions() != big.dimensions() || mean_diff(&unscaled, &big) > d + 1.0,
            "{k}x: ignoring the scale should change the picture"
        );
    }
}

#[test]
fn an_unscaled_state_renders_exactly_as_before() {
    let (src, mask) = corner();
    let mut a = shadow_state(hard_drop());
    let plain = render_with(&a, mask.as_ref(), &src, &ExportOptions::default()).unwrap();
    for ds in [0.0, 1.0, 0.5, f64::NAN] {
        a.detail_scale = ds;
        let r = render_with(&a, mask.as_ref(), &src, &ExportOptions::default()).unwrap();
        assert_eq!(r.as_raw(), plain.as_raw(), "detail_scale {ds}");
    }
}
