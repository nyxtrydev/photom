use std::io::Write;

use image::{GrayImage, Luma, Rgb, RgbImage};
use serde_json::json;
use zip::write::SimpleFileOptions;

use super::*;
use crate::models::project::ProjectImagePayload;

struct Fixture {
    dir: tempfile::TempDir,
    registry: ImageRegistry,
}

impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            registry: ImageRegistry::default(),
        }
    }

    fn p(&self, rel: &str) -> PathBuf {
        let p = self.dir.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        p
    }

    /// Register a real image (and optionally a mask) the way an import + removal would.
    fn add_image(&self, id: &str, with_mask: bool) {
        let src = self.p(&format!("src/{id}.png"));
        RgbImage::from_pixel(40, 30, Rgb([200, 90, 20]))
            .save(&src)
            .unwrap();
        let thumb = self.p(&format!("thumbs/{id}.png"));
        RgbImage::from_pixel(10, 8, Rgb([1, 2, 3]))
            .save(&thumb)
            .unwrap();
        let mask = with_mask.then(|| {
            let m = self.p(&format!("masks/{id}.png"));
            let mut g = GrayImage::new(40, 30);
            for y in 5..20 {
                for x in 10..30 {
                    g.put_pixel(x, y, Luma([255]));
                }
            }
            g.save(&m).unwrap();
            m
        });
        self.registry
            .insert(ImageRecord {
                meta: ImageMeta {
                    id: id.into(),
                    path: src.display().to_string(),
                    name: format!("{id}.png"),
                    width: 40,
                    height: 30,
                    format: "png".into(),
                    thumbnail_path: thumb.display().to_string(),
                },
                source: src,
                mask_path: mask,
            })
            .unwrap();
    }

    fn payload(&self, ids: &[&str]) -> ProjectPayload {
        ProjectPayload {
            project_id: "proj-1".into(),
            name: "Test project".into(),
            active_id: ids.first().map(|s| s.to_string()),
            original_path: None,
            images: ids
                .iter()
                .map(|id| ProjectImagePayload {
                    id: id.to_string(),
                    state: json!({"refine": {"threshold": 61, "feather": 3, "edgeShift": -2},
                                  "strokes": [{"mode": "keep", "size": 12, "hardness": 40, "points": [[1.5, 2.5, 1.0]]}]}),
                    background_source: None,
                })
                .collect(),
        }
    }

    fn open(&self, path: &Path) -> AppResult<(OpenedProject, ImageRegistry)> {
        let registry = ImageRegistry::default();
        let w = self.dir.path().join("open-work");
        let r = read_project(
            path,
            &registry,
            &w.join("projects"),
            &w.join("masks"),
            &w.join("thumbs"),
            100_000_000,
        )?;
        Ok((r, registry))
    }
}

const EMBED: WriteOptions = WriteOptions {
    embed_originals: true,
    keep_backup: true,
};

#[test]
fn round_trip_preserves_images_masks_and_state() {
    let f = Fixture::new();
    f.add_image("a", true);
    f.add_image("b", false);
    let dest = f.p("out/My Project é.photom");
    write_project(
        &f.payload(&["a", "b"]),
        &f.registry,
        &dest,
        EMBED,
        None,
        None,
    )
    .unwrap();

    let (opened, registry) = f.open(&dest).unwrap();
    assert_eq!(opened.meta.name, "Test project");
    assert_eq!(opened.meta.active_id.as_deref(), Some("a"));
    assert_eq!(opened.images.len(), 2);
    let a = &opened.images[0];
    assert_eq!((a.meta.width, a.meta.height), (40, 30));
    assert_eq!(a.state["refine"]["threshold"], 61);
    assert_eq!(a.state["strokes"][0]["points"][0][0], 1.5);
    let mask = a.mask.as_ref().expect("mask restored");
    assert_eq!(mask.bounding_box.unwrap().width, 20);
    assert!(opened.images[1].mask.is_none());
    // Registered for further use (removal, thumbnails).
    assert!(registry.get("a").is_ok());
    assert!(Path::new(&a.meta.thumbnail_path).is_file());
    // The embedded original is a stable copy, not the source file.
    assert!(a.meta.path.contains("open-work"));
}

#[test]
fn second_save_keeps_exactly_one_backup_of_the_previous_version() {
    let f = Fixture::new();
    f.add_image("a", true);
    let dest = f.p("p.photom");
    let mut payload = f.payload(&["a"]);
    write_project(&payload, &f.registry, &dest, EMBED, None, None).unwrap();
    payload.images[0].state = json!({"version": "second"});
    write_project(&payload, &f.registry, &dest, EMBED, None, None).unwrap();

    let bak = backup_path(&dest);
    assert!(bak.is_file());
    assert_eq!(
        f.open(&dest).unwrap().0.images[0].state["version"],
        "second"
    );
    assert_eq!(
        f.open(&bak).unwrap().0.images[0].state["refine"]["threshold"],
        61
    );
    // No stray temp files.
    let leftovers: Vec<_> = fs::read_dir(dest.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn failed_save_leaves_the_existing_file_untouched() {
    let f = Fixture::new();
    f.add_image("a", true);
    let dest = f.p("p.photom");
    write_project(&f.payload(&["a"]), &f.registry, &dest, EMBED, None, None).unwrap();
    let before = fs::read(&dest).unwrap();

    let mut bad = f.payload(&["a"]);
    bad.images.push(ProjectImagePayload {
        id: "missing".into(),
        state: json!({}),
        background_source: None,
    });
    assert!(write_project(&bad, &f.registry, &dest, EMBED, None, None).is_err());
    assert_eq!(fs::read(&dest).unwrap(), before);
    assert!(!backup_path(&dest).exists());
}

#[test]
fn autosave_links_originals_but_embeds_ones_living_in_the_cache() {
    let f = Fixture::new();
    f.add_image("a", false);
    let dest = f.p("auto/proj.photom.tmp");
    let opts = WriteOptions {
        embed_originals: false,
        keep_backup: false,
    };
    write_project(&f.payload(&["a"]), &f.registry, &dest, opts, None, None).unwrap();
    let m = read_manifest(&dest).unwrap();
    assert!(m.images[0].original_file.is_none());
    assert!(m.images[0].source_path.is_some());

    // Same image, but its source is inside the managed cache dir => embedded.
    let managed = f.dir.path().join("src");
    let dest2 = f.p("auto/proj2.photom.tmp");
    write_project(
        &f.payload(&["a"]),
        &f.registry,
        &dest2,
        opts,
        None,
        Some(&managed),
    )
    .unwrap();
    assert!(read_manifest(&dest2).unwrap().images[0]
        .original_file
        .is_some());
}

#[test]
fn linked_original_that_disappeared_becomes_a_warning_not_a_failure() {
    let f = Fixture::new();
    f.add_image("a", false);
    f.add_image("b", false);
    let dest = f.p("auto/p.photom.tmp");
    let opts = WriteOptions {
        embed_originals: false,
        keep_backup: false,
    };
    write_project(
        &f.payload(&["a", "b"]),
        &f.registry,
        &dest,
        opts,
        None,
        None,
    )
    .unwrap();
    fs::remove_file(f.p("src/b.png")).unwrap();
    let (opened, _) = f.open(&dest).unwrap();
    assert_eq!(opened.images.len(), 1);
    assert_eq!(opened.warnings.len(), 1);
    assert!(opened.warnings[0].contains("b.png"));
}

#[test]
fn background_picture_is_embedded_and_restored() {
    let f = Fixture::new();
    f.add_image("a", true);
    let bg = f.p("bg.png");
    RgbImage::from_pixel(20, 20, Rgb([0, 255, 0]))
        .save(&bg)
        .unwrap();
    let mut payload = f.payload(&["a"]);
    payload.images[0].state =
        json!({"background": {"kind": "image", "image": {"sourcePath": "x"}}});
    payload.images[0].background_source = Some(bg.display().to_string());
    let dest = f.p("p.photom");
    write_project(&payload, &f.registry, &dest, EMBED, None, None).unwrap();

    let (opened, _) = f.open(&dest).unwrap();
    let cache_path = opened.images[0].state["background"]["image"]["cachePath"]
        .as_str()
        .expect("background re-prepared");
    assert!(Path::new(cache_path).is_file());
}

#[test]
fn migrates_v0_manifests() {
    let v0 = json!({
        "images": [{"id": "a", "name": "a.png", "width": 4, "height": 3, "format": "png", "file": "images/a/original.png"}]
    });
    let m: Manifest = serde_json::from_value(migrate_manifest(v0).unwrap()).unwrap();
    assert_eq!(m.format_version, 1);
    assert!(!m.project_id.is_empty());
    assert_eq!(
        m.images[0].original_file.as_deref(),
        Some("images/a/original.png")
    );
    assert_eq!(m.images[0].state_file, "images/a/state.json");
}

#[test]
fn rejects_projects_from_the_future() {
    let e = migrate_manifest(json!({"formatVersion": 99})).unwrap_err();
    assert_eq!(e.code(), "ProjectCorrupt");
    assert!(e.to_string().contains("newer version"));
}

#[test]
fn corrupt_files_give_a_recoverable_error_not_a_crash() {
    let f = Fixture::new();
    // Not a zip at all.
    let junk = f.p("junk.photom");
    fs::write(&junk, b"this is not a zip").unwrap();
    assert_eq!(f.open(&junk).unwrap_err().code(), "ProjectCorrupt");

    // Truncated real project.
    f.add_image("a", true);
    let good = f.p("good.photom");
    write_project(&f.payload(&["a"]), &f.registry, &good, EMBED, None, None).unwrap();
    let bytes = fs::read(&good).unwrap();
    let cut = f.p("cut.photom");
    fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    assert_eq!(f.open(&cut).unwrap_err().code(), "ProjectCorrupt");

    // Valid zip without a manifest.
    let empty = f.p("empty.photom");
    let mut z = ZipWriter::new(File::create(&empty).unwrap());
    z.start_file("hello.txt", SimpleFileOptions::default())
        .unwrap();
    z.write_all(b"hi").unwrap();
    z.finish().unwrap();
    assert_eq!(f.open(&empty).unwrap_err().code(), "ProjectCorrupt");

    // Missing file is a clear InvalidInput, not corruption.
    assert_eq!(
        f.open(&f.p("nope.photom")).unwrap_err().code(),
        "InvalidInput"
    );
}

#[test]
fn hostile_image_ids_cannot_escape_the_extraction_folder() {
    let f = Fixture::new();
    let evil = f.p("evil.photom");
    let mut z = ZipWriter::new(File::create(&evil).unwrap());
    let manifest = json!({
        "formatVersion": 1, "appVersion": "1", "projectId": "p", "name": "x",
        "created": "t", "modified": "t", "originalPath": null, "activeId": null,
        "images": [{"id": "../../escape", "name": "x", "width": 1, "height": 1, "format": "png",
                    "originalFile": "images/x/original.png", "sourcePath": null, "maskFile": null,
                    "stateFile": "s.json", "thumbFile": null, "backgroundFile": null}]
    });
    z.start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    z.write_all(manifest.to_string().as_bytes()).unwrap();
    z.finish().unwrap();
    assert_eq!(f.open(&evil).unwrap_err().code(), "ProjectCorrupt");
}

#[test]
fn destination_always_gets_the_photom_extension() {
    assert_eq!(
        normalise_destination(Path::new("/x/a")),
        PathBuf::from("/x/a.photom")
    );
    assert_eq!(
        normalise_destination(Path::new("/x/a.PHOTOM")),
        PathBuf::from("/x/a.PHOTOM")
    );
    assert_eq!(
        normalise_destination(Path::new("/x/a.png")),
        PathBuf::from("/x/a.png.photom")
    );
}
