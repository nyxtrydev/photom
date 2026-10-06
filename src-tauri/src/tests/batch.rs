//! Acceptance: a 40-image batch export completes with per-item status, a failing item does not
//! stop the batch, nothing is overwritten, and Cancel stops cleanly.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use image::{GrayImage, Luma, Rgb, RgbImage};
use serde_json::{json, Value};

use crate::infra::job_queue::{ItemError, ItemStatus, JobEvents, JobQueue, JobSnapshot, JobStatus};
use crate::models::dto::ImageMeta;
use crate::services::exporter::{
    self, CropOptions, ExportOptions, ItemRequest, ItemState, SizeMode, SizeOptions,
};
use crate::services::import::{ImageRecord, ImageRegistry};
use crate::services::maskops::RefineParams;

#[derive(Default)]
struct Events(Mutex<Vec<String>>);
impl JobEvents for Events {
    fn progress(&self, _: &str, _: usize, _: usize, _: Option<&str>, _: JobStatus) {}
    fn item_complete(&self, _: &str, id: &str, _: &Value) {
        self.0.lock().unwrap().push(format!("ok:{id}"));
    }
    fn item_error(&self, _: &str, id: &str, e: &ItemError) {
        self.0.lock().unwrap().push(format!("err:{id}:{}", e.code));
    }
}

/// `n` images that all share the file name `photo.png` (in different folders), so the output
/// names collide and must be auto-numbered. Image 7 has no mask; image 13's source is corrupt.
fn build(dir: &Path, n: usize) -> (ImageRegistry, Vec<String>) {
    let reg = ImageRegistry::default();
    let mut ids = Vec::new();
    for i in 0..n {
        let folder = dir.join(format!("src{i}"));
        std::fs::create_dir_all(&folder).unwrap();
        let src = folder.join("photo.png");
        if i == 13 {
            std::fs::write(&src, b"not an image").unwrap();
        } else {
            RgbImage::from_pixel(120, 90, Rgb([200, 100, (i * 5) as u8]))
                .save(&src)
                .unwrap();
        }
        let mask = (i != 7).then(|| {
            let m = folder.join("mask.png");
            GrayImage::from_fn(120, 90, |x, y| {
                Luma([if (30..90).contains(&x) && (20..70).contains(&y) {
                    255
                } else {
                    0
                }])
            })
            .save(&m)
            .unwrap();
            m
        });
        let id = format!("img{i}");
        reg.insert(ImageRecord {
            meta: ImageMeta {
                id: id.clone(),
                path: src.display().to_string(),
                name: "photo.png".into(),
                width: 120,
                height: 90,
                format: "png".into(),
                thumbnail_path: String::new(),
            },
            source: src,
            mask_path: mask,
        })
        .unwrap();
        ids.push(id);
    }
    (reg, ids)
}

fn wait(q: &JobQueue, id: &str) -> JobSnapshot {
    let t = Instant::now();
    loop {
        let s = q.snapshot(id).unwrap();
        if matches!(s.status, JobStatus::Done | JobStatus::Cancelled) {
            return s;
        }
        assert!(t.elapsed() < Duration::from_secs(60), "batch timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn job(
    q: &JobQueue,
    reg: ImageRegistry,
    ids: &[String],
    out: &Path,
    delay: Duration,
) -> (String, Arc<Events>) {
    let events = Arc::new(Events::default());
    let opts = ExportOptions {
        folder: out.display().to_string(),
        crop: CropOptions {
            enabled: true,
            padding: 6,
        },
        size: SizeOptions {
            mode: SizeMode::Original,
            width: 0,
            height: 0,
            max_side: None,
        },
        ..ExportOptions::default()
    };
    let total = ids.len();
    let labels = ids
        .iter()
        .map(|i| (i.clone(), "photo.png".to_string()))
        .collect();
    let id = q.start("export", labels, 1, events.clone(), move |index, id| {
        std::thread::sleep(delay);
        let rec = reg.get(id)?;
        let (item, _) = exporter::export_item(&ItemRequest {
            rec: &rec,
            state: &ItemState {
                refine: RefineParams {
                    threshold: 0.0,
                    feather: 0.0,
                    edge_shift: 0.0,
                },
                ..ItemState::default()
            },
            options: &opts,
            index: index + 1,
            total,
            date: "2026-10-05",
            pixel_limit: 100_000_000,
        })?;
        Ok(json!({ "path": item.output_path, "w": item.width, "h": item.height }))
    });
    (id, events)
}

#[test]
fn forty_image_batch_reports_per_item_status_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let (reg, ids) = build(dir.path(), 40);
    let out = dir.path().join("out");
    let q = JobQueue::default();
    let (id, events) = job(&q, reg, &ids, &out, Duration::ZERO);
    let s = wait(&q, &id);

    assert_eq!(s.status, JobStatus::Done);
    assert_eq!((s.done, s.total), (40, 40));
    let failed: Vec<_> = s
        .items
        .iter()
        .filter(|i| i.status == ItemStatus::Failed)
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(failed, ["img7", "img13"]); // no mask / corrupt file; everything else carried on
    assert_eq!(
        s.items
            .iter()
            .filter(|i| i.status == ItemStatus::Done)
            .count(),
        38
    );
    assert_eq!(s.items[7].error.as_ref().unwrap().code, "ExportFailed");
    assert!(["Decode", "UnsupportedFormat"]
        .contains(&s.items[13].error.as_ref().unwrap().code.as_str()));
    assert_eq!(events.0.lock().unwrap().len(), 40);

    // All 38 outputs exist as distinct files (same name => numbered), each with exact crop size.
    let files: Vec<_> = std::fs::read_dir(&out)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 38);
    for it in s.items.iter().filter(|i| i.status == ItemStatus::Done) {
        let r = it.result.as_ref().unwrap();
        assert_eq!(
            (r["w"].as_u64().unwrap(), r["h"].as_u64().unwrap()),
            (60 + 12, 50 + 12)
        ); // subject + exact padding
        assert!(Path::new(r["path"].as_str().unwrap()).is_file());
    }
}

#[test]
fn running_the_same_batch_twice_keeps_every_earlier_file() {
    let dir = tempfile::tempdir().unwrap();
    let (reg, ids) = build(dir.path(), 6);
    let out = dir.path().join("out");
    let q = JobQueue::default();
    for _ in 0..2 {
        let (id, _) = job(&q, reg.clone(), &ids[..4], &out, Duration::ZERO);
        wait(&q, &id);
    }
    assert_eq!(std::fs::read_dir(&out).unwrap().count(), 8); // 4 + 4, nothing replaced
}

#[test]
fn cancel_stops_the_batch_cleanly_with_no_partial_files() {
    let dir = tempfile::tempdir().unwrap();
    let (reg, ids) = build(dir.path(), 40);
    let out = dir.path().join("out");
    let q = JobQueue::default();
    let (id, _) = job(&q, reg, &ids, &out, Duration::from_millis(25));
    std::thread::sleep(Duration::from_millis(150));
    q.cancel(&id).unwrap();
    let s = wait(&q, &id);

    assert_eq!(s.status, JobStatus::Cancelled);
    let done = s
        .items
        .iter()
        .filter(|i| i.status == ItemStatus::Done)
        .count();
    let cancelled = s
        .items
        .iter()
        .filter(|i| i.status == ItemStatus::Cancelled)
        .count();
    assert!((1..38).contains(&done), "some finished, not all: {done}");
    assert!(cancelled > 0);
    assert!(s
        .items
        .iter()
        .all(|i| i.status != ItemStatus::Queued && i.status != ItemStatus::Processing));
    // Every file on disk is a complete, decodable PNG belonging to a finished item.
    let files: Vec<_> = std::fs::read_dir(&out)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), done);
    assert!(files.iter().all(|f| image::open(f).is_ok()));
}

/// Resident memory of this process in MB (via `ps`; Unix only).
#[cfg(unix)]
fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
        / 1024.0
}

/// Performance + memory of a long batch of 12 MP exports.
/// `cargo test --release -- --ignored twelve_mp --nocapture`
#[test]
#[ignore]
#[cfg(unix)]
fn twelve_mp_batch_is_fast_and_does_not_leak() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("big.jpg");
    RgbImage::from_fn(4000, 3000, |x, y| {
        Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8])
    })
    .save(&src)
    .unwrap();
    let mask = dir.path().join("mask.png");
    GrayImage::from_fn(4000, 3000, |x, y| {
        let d = ((x as f32 - 2000.0).powi(2) + (y as f32 - 1500.0).powi(2)).sqrt();
        Luma([if d < 1100.0 {
            255
        } else if d < 1130.0 {
            (255.0 * (1130.0 - d) / 30.0) as u8
        } else {
            0
        }])
    })
    .save(&mask)
    .unwrap();
    let rec = ImageRecord {
        meta: ImageMeta {
            id: "big".into(),
            path: src.display().to_string(),
            name: "big.jpg".into(),
            width: 4000,
            height: 3000,
            format: "jpeg".into(),
            thumbnail_path: String::new(),
        },
        source: src,
        mask_path: Some(mask),
    };
    let opts = ExportOptions {
        folder: dir.path().join("out").display().to_string(),
        crop: CropOptions {
            enabled: true,
            padding: 20,
        },
        compression: 6,
        ..ExportOptions::default()
    };
    let state = ItemState::default(); // default refine: threshold + feather 2
    let mut times = Vec::new();
    let mut rss = Vec::new();
    for i in 0..16 {
        let t = Instant::now();
        let (item, _) = exporter::export_item(&ItemRequest {
            rec: &rec,
            state: &state,
            options: &opts,
            index: i + 1,
            total: 16,
            date: "2026-10-05",
            pixel_limit: 100_000_000,
        })
        .unwrap();
        times.push(t.elapsed());
        rss.push(rss_mb());
        if i == 0 {
            eprintln!(
                "output {}x{}, {:.1} MB",
                item.width,
                item.height,
                item.bytes as f64 / 1e6
            );
        }
    }
    let ms: Vec<u128> = times.iter().map(|t| t.as_millis()).collect();
    eprintln!("12 MP export per item (ms): {ms:?}");
    eprintln!(
        "RSS after each item (MB): {:?}",
        rss.iter().map(|r| r.round() as i64).collect::<Vec<_>>()
    );
    let growth = rss[15] - rss[3];
    eprintln!("RSS growth from item 4 to item 16: {growth:.0} MB");
    assert!(
        growth < 150.0,
        "memory keeps growing across a batch: {growth} MB"
    );
}
