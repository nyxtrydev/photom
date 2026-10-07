use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use super::*;
use crate::infra::model_manager::ModelManager;
use crate::model_hub::manifest::canonical_json;

fn sk() -> SigningKey {
    SigningKey::from_bytes(&[5u8; 32])
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn body(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

fn entry(id: &str, version: &str, urls: &[String], data: &[u8]) -> Value {
    json!({
        "id": id, "name": id, "feature": "f", "version": version, "description": "",
        "sizeBytes": data.len(), "sha256": sha(data), "format": "onnx",
        "files": [{ "path": "model.onnx", "sizeBytes": data.len(), "sha256": sha(data) }],
        "urls": urls,
        "license": { "name": "MIT", "url": "https://x.example", "commercialUse": true, "attribution": "" },
        "requirements": { "minRamMb": 1, "gpuOptional": true },
        "runtime": { "inputSize": [1, 1], "normalization": "none", "notes": "" },
        "recommended": true, "dependsOn": [],
    })
}

fn signed(models: Vec<Value>, generated_at: &str) -> String {
    let models = Value::Array(models);
    let sig = sk().sign(canonical_json(&models).as_bytes());
    json!({
        "schemaVersion": 1, "generatedAt": generated_at,
        "models": models, "signature": STANDARD.encode(sig.to_bytes()),
    })
    .to_string()
}

/// Serves `body`, honouring Range unless told not to, and can fail the first few requests.
#[derive(Clone)]
struct Blob {
    body: Arc<Vec<u8>>,
    ranges: bool,
    seen: Arc<Mutex<Vec<Option<String>>>>,
    fail_first: Arc<AtomicUsize>,
}

impl Blob {
    fn new(body: Vec<u8>) -> Self {
        Self {
            body: Arc::new(body),
            ranges: true,
            seen: Default::default(),
            fail_first: Default::default(),
        }
    }
}

impl Respond for Blob {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        if self
            .fail_first
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return ResponseTemplate::new(503);
        }
        let range = req
            .headers
            .get("range")
            .map(|v| v.to_str().unwrap().to_string());
        self.seen.lock().unwrap().push(range.clone());
        let len = self.body.len();
        let start = range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.trim_end_matches('-').parse::<usize>().ok());
        match start {
            Some(s) if self.ranges && s < len => ResponseTemplate::new(206)
                .insert_header("Content-Range", format!("bytes {s}-{}/{len}", len - 1))
                .set_body_bytes(self.body[s..].to_vec()),
            Some(s) if self.ranges && s >= len => ResponseTemplate::new(416),
            _ => ResponseTemplate::new(200).set_body_bytes(self.body.to_vec()),
        }
    }
}

type Events = Arc<Mutex<Vec<(String, Value)>>>;

struct Env {
    server: MockServer,
    dir: tempfile::TempDir,
    hub: Arc<ModelHub>,
    installer: Arc<Installer>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

fn net() -> NetConfig {
    NetConfig {
        allowed_hosts: vec!["127.0.0.1".into()],
        https_only: false,
        attempts: 3,
        backoff_base: Duration::from_millis(1),
        progress_interval: Duration::ZERO,
        free_space: Arc::new(|_| u64::MAX),
        ..NetConfig::default()
    }
}

fn build(
    dir: &std::path::Path,
    catalog: &str,
    cfg: NetConfig,
) -> (Arc<ModelHub>, Arc<Installer>, Events) {
    let events: Arc<Mutex<Vec<(String, Value)>>> = Default::default();
    let sink = events.clone();
    let hub = Arc::new(ModelHub::with_catalog_opts(
        dir.to_path_buf(),
        ModelManager::new(None, None),
        Arc::new(move |n, p| sink.lock().unwrap().push((n.to_string(), p))),
        catalog,
        &sk().verifying_key().to_bytes(),
        false,
    ));
    let installer = Installer::new(hub.clone(), cfg, Handle::current()).unwrap();
    (hub, installer, events)
}

async fn env(models: impl FnOnce(&str) -> Vec<Value>, cfg: NetConfig) -> Env {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let catalog = signed(models(&server.uri()), "2026-01-01T00:00:00Z");
    let (hub, installer, events) = build(dir.path(), &catalog, cfg);
    Env {
        server,
        dir,
        hub,
        installer,
        events,
    }
}

async fn serve(server: &MockServer, p: &str, blob: Blob) {
    Mock::given(method("GET"))
        .and(path(p.to_string()))
        .respond_with(blob)
        .mount(server)
        .await;
}

async fn wait_for(hub: &ModelHub, id: &str, want: impl Fn(&ModelState) -> bool) -> ModelState {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        let s = hub.state_of(id);
        if want(&s) {
            return s;
        }
        assert!(Instant::now() < end, "timed out in state {s:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn is_final(s: &ModelState) -> bool {
    matches!(s, ModelState::Installed | ModelState::Failed { .. })
}

fn states(ev: &Mutex<Vec<(String, Value)>>, id: &str) -> Vec<String> {
    ev.lock()
        .unwrap()
        .iter()
        .filter(|(n, p)| n == "model:state" && p["id"] == id)
        .map(|(_, p)| p["state"]["kind"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn downloads_verifies_and_installs_atomically() {
    let data = body(300_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(data.clone())).await;

    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);

    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), data);
    assert!(e.dir.path().join("a/1.0.0/meta.json").is_file());
    let staging = e.dir.path().join(".downloads/a-1.0.0");
    assert!(!staging.exists(), "staging is gone after the atomic rename");
    assert_eq!(
        states(&e.events, "a"),
        [
            "queued",
            "downloading",
            "verifying",
            "installing",
            "installed"
        ]
    );
    let progress: Vec<_> = e
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "model:progress")
        .cloned()
        .collect();
    assert!(!progress.is_empty());
    let last = &progress.last().unwrap().1;
    assert_eq!(last["downloadedBytes"], 300_000);
    assert_eq!(last["totalBytes"], 300_000);
}

#[tokio::test]
async fn a_second_install_call_is_a_no_op() {
    let data = body(1000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(data)).await;
    e.installer.install("a").unwrap();
    e.installer.install("a").unwrap();
    wait_for(&e.hub, "a", is_final).await;
    e.installer.install("a").unwrap();
    assert_eq!(e.hub.state_of("a"), ModelState::Installed);
}

#[tokio::test]
async fn resumes_from_a_partial_file_left_by_a_killed_app() {
    let data = body(200_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let blob = Blob::new(data.clone());
    serve(&e.server, "/m.onnx", blob.clone()).await;
    // What a killed download leaves behind.
    let staging = e.dir.path().join(".downloads/a-1.0.0");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("model.onnx.part"), &data[..80_000]).unwrap();

    // A fresh start (new process) sees it as Paused, then resumes.
    let (hub, installer, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{}/m.onnx", e.server.uri())],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    assert_eq!(hub.state_of("a"), ModelState::Paused);
    installer.resume("a").unwrap();
    assert_eq!(wait_for(&hub, "a", is_final).await, ModelState::Installed);

    assert_eq!(std::fs::read(hub.model_path("a").unwrap()).unwrap(), data);
    assert_eq!(
        blob.seen.lock().unwrap().as_slice(),
        [Some("bytes=80000-".to_string())]
    );
}

#[tokio::test]
async fn a_server_without_range_support_restarts_from_zero() {
    let data = body(150_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let mut blob = Blob::new(data.clone());
    blob.ranges = false;
    serve(&e.server, "/m.onnx", blob).await;
    let staging = e.dir.path().join(".downloads/a-1.0.0");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("model.onnx.part"), &data[..50_000]).unwrap();

    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), data);
}

#[tokio::test]
async fn a_corrupted_download_is_discarded_and_reported() {
    let good = body(100_000);
    let mut bad = good.clone();
    bad[5000] ^= 0xff;
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &good)],
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(bad)).await;

    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(
        matches!(&s, ModelState::Failed { code, .. } if code == "HashMismatch"),
        "{s:?}"
    );
    assert!(e.hub.model_path("a").is_err());
    assert!(!e
        .dir
        .path()
        .join(".downloads/a-1.0.0/model.onnx.part")
        .exists());
    assert!(!e.dir.path().join("a").exists());
    let errs = e
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "model:error")
        .count();
    assert_eq!(errs, 1);

    // Retry with a healthy server works.
    e.server.reset().await;
    serve(&e.server, "/m.onnx", Blob::new(good.clone())).await;
    e.installer.install("a").unwrap();
    assert_eq!(
        wait_for(&e.hub, "a", |s| *s == ModelState::Installed).await,
        ModelState::Installed
    );
}

#[tokio::test]
async fn fails_over_to_the_next_mirror() {
    let data = body(50_000);
    let e = env(
        |u| {
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{u}/missing.onnx"), format!("{u}/m.onnx")],
                &data,
            )]
        },
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(data.clone())).await;
    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), data);
}

#[tokio::test]
async fn a_corrupt_first_mirror_falls_back_to_a_good_one() {
    let data = body(50_000);
    let mut bad = data.clone();
    bad[10] ^= 1;
    let e = env(
        |u| {
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{u}/bad.onnx"), format!("{u}/good.onnx")],
                &data,
            )]
        },
        net(),
    )
    .await;
    serve(&e.server, "/bad.onnx", Blob::new(bad)).await;
    serve(&e.server, "/good.onnx", Blob::new(data.clone())).await;
    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), data);
    let kinds = states(&e.events, "a");
    assert_eq!(
        kinds.iter().filter(|k| *k == "verifying").count(),
        2,
        "{kinds:?}"
    );
}

#[tokio::test]
async fn transient_server_errors_are_retried() {
    let data = body(20_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let blob = Blob::new(data);
    blob.fail_first.store(2, Ordering::SeqCst);
    serve(&e.server, "/m.onnx", blob).await;
    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
}

#[tokio::test]
async fn gives_up_with_a_network_error_after_all_attempts() {
    let data = body(20_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let blob = Blob::new(data);
    blob.fail_first.store(100, Ordering::SeqCst);
    serve(&e.server, "/m.onnx", blob).await;
    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(
        matches!(&s, ModelState::Failed { code, .. } if code == "Network"),
        "{s:?}"
    );
}

#[tokio::test]
async fn a_server_sending_more_than_the_manifest_size_is_cut_off() {
    let data = body(10_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(body(500_000))).await;
    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(matches!(s, ModelState::Failed { .. }));
    assert!(!e
        .dir
        .path()
        .join(".downloads/a-1.0.0/model.onnx.part")
        .exists());
    assert!(e.hub.model_path("a").is_err());
}

#[tokio::test]
async fn a_redirect_to_a_disallowed_host_is_refused() {
    let data = body(10_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    Mock::given(method("GET"))
        .and(path("/m.onnx"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("Location", "http://localhost:1/evil.onnx"),
        )
        .mount(&e.server)
        .await;
    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(
        matches!(&s, ModelState::Failed { code, .. } if code == "Network"),
        "{s:?}"
    );
}

#[tokio::test]
async fn a_redirect_within_the_allowlist_is_followed() {
    let data = body(10_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    Mock::given(method("GET"))
        .and(path("/m.onnx"))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", "/real.onnx"))
        .mount(&e.server)
        .await;
    serve(&e.server, "/real.onnx", Blob::new(data)).await;
    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
}

#[tokio::test]
async fn a_url_on_an_unlisted_host_never_connects() {
    let data = body(1000);
    let e = env(
        |_| {
            vec![entry(
                "a",
                "1.0.0",
                &["http://localhost:9/m.onnx".to_string()],
                &data,
            )]
        },
        net(),
    )
    .await;
    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(
        matches!(&s, ModelState::Failed { code, message } if code == "Network" && message.contains("not allowed")),
        "{s:?}"
    );
}

#[tokio::test]
async fn https_is_required_in_production_settings() {
    let cfg = NetConfig::default();
    let url = reqwest::Url::parse("http://models.photom.example/x").unwrap();
    assert!(downloader::check_url(&cfg, &url).is_err());
    let ok = reqwest::Url::parse("https://MODELS.photom.example/x").unwrap();
    assert!(downloader::check_url(&cfg, &ok).is_ok());
    let other = reqwest::Url::parse("https://evil.example/x").unwrap();
    assert!(downloader::check_url(&cfg, &other).is_err());
}

#[tokio::test]
async fn not_enough_disk_space_is_reported_before_downloading() {
    let data = body(1000);
    let cfg = NetConfig {
        free_space: Arc::new(|_| 1_000),
        ..net()
    };
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        cfg,
    )
    .await;
    let err = e.installer.install("a").unwrap_err();
    assert_eq!(err.code(), "DiskFull");
    assert!(err.to_string().contains("MB"));
    assert_eq!(e.hub.state_of("a"), ModelState::NotInstalled);
    assert!(e.server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn placeholder_models_cannot_be_installed() {
    let data = body(10);
    let mut m = entry("a", "1.0.0", &["https://x.example/m".to_string()], &data);
    m["sha256"] = crate::model_hub::config::PLACEHOLDER_SHA256.into();
    let e = env(|_| vec![m], net()).await;
    let err = e.installer.install("a").unwrap_err();
    assert!(err.to_string().contains("not available"));
}

#[tokio::test]
async fn dependencies_install_first() {
    let a = body(1000);
    let b = body(2000);
    let e = env(
        |u| {
            let mut main = entry("main", "1.0.0", &[format!("{u}/b.onnx")], &b);
            main["dependsOn"] = json!(["dep"]);
            vec![main, entry("dep", "1.0.0", &[format!("{u}/a.onnx")], &a)]
        },
        net(),
    )
    .await;
    serve(&e.server, "/a.onnx", Blob::new(a)).await;
    serve(&e.server, "/b.onnx", Blob::new(b)).await;
    e.installer.install("main").unwrap();
    wait_for(&e.hub, "main", is_final).await;
    assert!(e.hub.is_ready("dep") && e.hub.is_ready("main"));
    let order: Vec<String> = e
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(n, p)| n == "model:state" && p["state"]["kind"] == "installed")
        .map(|(_, p)| p["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(order, ["dep", "main"]);
}

#[tokio::test]
async fn cancelling_a_paused_download_removes_its_files() {
    let data = body(100_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let staging = e.dir.path().join(".downloads/a-1.0.0");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("model.onnx.part"), &data[..1000]).unwrap();
    let (hub, installer, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{}/m.onnx", e.server.uri())],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    assert_eq!(hub.state_of("a"), ModelState::Paused);
    installer.cancel("a").unwrap();
    assert_eq!(hub.state_of("a"), ModelState::NotInstalled);
    assert!(!staging.exists());
}

#[tokio::test]
async fn pausing_stops_mid_file_and_resuming_finishes_without_refetching() {
    let data = body(4_000_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let blob = Blob::new(data.clone());
    serve(&e.server, "/m.onnx", blob.clone()).await;
    let cfg = net();
    let client = downloader::build_client(&cfg).unwrap();
    let part = e.dir.path().join("x.part");
    let url = format!("{}/m.onnx", e.server.uri());
    let ctl = downloader::Control::default();

    let mut first_seen = 0u64;
    let mut cb = |done: u64, _s: u64| {
        if done > 0 {
            first_seen = done;
            ctl.pause.store(true, Ordering::Relaxed);
        }
    };
    let out =
        downloader::download_url(&client, &cfg, &url, &part, data.len() as u64, &ctl, &mut cb)
            .await
            .unwrap();
    assert_eq!(out, downloader::Outcome::Paused);
    let kept = std::fs::metadata(&part).unwrap().len();
    assert!(kept > 0 && kept < data.len() as u64, "kept {kept}");
    assert!(first_seen > 0);

    let ctl2 = downloader::Control::default();
    let out = downloader::download_url(
        &client,
        &cfg,
        &url,
        &part,
        data.len() as u64,
        &ctl2,
        &mut |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(out, downloader::Outcome::Completed);
    assert_eq!(std::fs::read(&part).unwrap(), data);
    let seen = blob.seen.lock().unwrap();
    assert_eq!(seen[1], Some(format!("bytes={kept}-")));
}

#[tokio::test]
async fn zip_packages_are_extracted_safely() {
    let mut zipped = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zipped));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("model.onnx", opts).unwrap();
        w.write_all(b"weights").unwrap();
        w.start_file("vocab/words.txt", opts).unwrap();
        w.write_all(b"words").unwrap();
        w.finish().unwrap();
    }
    let mut m = |u: &str| {
        let mut m = entry("a", "1.0.0", &[format!("{u}/p.zip")], &zipped);
        m["format"] = "zip".into();
        m["files"][0]["path"] = "package.zip".into();
        vec![m]
    };
    let e = env(&mut m, net()).await;
    serve(&e.server, "/p.zip", Blob::new(zipped.clone())).await;
    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
    assert_eq!(
        std::fs::read(e.hub.model_path("a").unwrap()).unwrap(),
        b"weights"
    );
    assert!(e.dir.path().join("a/1.0.0/vocab/words.txt").is_file());
    assert!(!e.dir.path().join("a/1.0.0/package.zip").exists());
}

#[tokio::test]
async fn a_malicious_zip_fails_and_installs_nothing() {
    let mut zipped = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut zipped));
        w.start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
    }
    let e = env(
        |u| {
            let mut m = entry("a", "1.0.0", &[format!("{u}/p.zip")], &zipped);
            m["format"] = "zip".into();
            vec![m]
        },
        net(),
    )
    .await;
    serve(&e.server, "/p.zip", Blob::new(zipped)).await;
    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(matches!(s, ModelState::Failed { .. }));
    assert!(e.hub.model_path("a").is_err());
    assert!(!e.dir.path().join("escape.txt").exists());
}

#[tokio::test]
async fn an_update_replaces_the_old_version() {
    let v1 = body(5_000);
    let v2 = body(6_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &v1)],
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(v1.clone())).await;
    e.installer.install("a").unwrap();
    wait_for(&e.hub, "a", is_final).await;
    assert!(e.dir.path().join("a/1.0.0/model.onnx").is_file());

    // A newer catalog arrives (same hub, same registry).
    let json2 = signed(
        vec![entry(
            "a",
            "1.1.0",
            &[format!("{}/m2.onnx", e.server.uri())],
            &v2,
        )],
        "2026-02-01T00:00:00Z",
    );
    let cat =
        manifest::parse_verified_opts(&json2, &sk().verifying_key().to_bytes(), false).unwrap();
    e.hub.set_catalog(cat, &json2).unwrap();
    assert_eq!(e.hub.state_of("a"), ModelState::UpdateAvailable);
    assert!(
        e.hub.is_ready("a"),
        "the old version keeps working until the swap"
    );

    serve(&e.server, "/m2.onnx", Blob::new(v2.clone())).await;
    e.installer.install("a").unwrap();
    wait_for(&e.hub, "a", |s| *s == ModelState::Installed).await;
    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), v2);
    assert!(!e.dir.path().join("a/1.0.0").exists());
    assert_eq!(e.hub.list()[0].installed_version.as_deref(), Some("1.1.0"));
}

#[tokio::test]
async fn catalog_refresh_accepts_a_newer_signed_catalog_and_remembers_it() {
    let data = body(100);
    let mut cfg = net();
    let server = MockServer::start().await;
    cfg.catalog_url = format!("{}/catalog.json", server.uri());
    let dir = tempfile::tempdir().unwrap();
    let old = signed(
        vec![entry("a", "1.0.0", &[format!("{}/m", server.uri())], &data)],
        "2026-01-01T00:00:00Z",
    );
    let (hub, installer, events) = build(dir.path(), &old, cfg.clone());
    let newer = signed(
        vec![
            entry("a", "1.0.0", &[format!("{}/m", server.uri())], &data),
            entry("b", "1.0.0", &[format!("{}/m", server.uri())], &data),
        ],
        "2026-03-01T00:00:00Z",
    );
    Mock::given(method("GET"))
        .and(path("/catalog.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(newer.clone()))
        .mount(&server)
        .await;

    let status = installer.refresh_catalog().await;
    assert_eq!(status.source, crate::model_hub::hub::CatalogSource::Remote);
    assert!(status.warning.is_none());
    assert_eq!(hub.list().len(), 2);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|(n, _)| n == "catalog:updated"));

    // Next start uses the cached copy even though the bundled one is older.
    let (hub2, _, _) = build(dir.path(), &old, cfg);
    assert_eq!(hub2.list().len(), 2);
    assert_eq!(
        hub2.catalog_status().source,
        crate::model_hub::hub::CatalogSource::Remote
    );
}

#[tokio::test]
async fn catalog_refresh_rejects_tampered_and_older_catalogs() {
    let data = body(100);
    let mut cfg = net();
    let server = MockServer::start().await;
    cfg.catalog_url = format!("{}/catalog.json", server.uri());
    let dir = tempfile::tempdir().unwrap();
    let cur = signed(
        vec![entry("a", "1.0.0", &[format!("{}/m", server.uri())], &data)],
        "2026-02-01T00:00:00Z",
    );
    let (hub, installer, _) = build(dir.path(), &cur, cfg);

    let tampered = signed(
        vec![
            entry("a", "1.0.0", &[format!("{}/m", server.uri())], &data),
            entry("b", "1.0.0", &[format!("{}/m", server.uri())], &data),
        ],
        "2026-03-01T00:00:00Z",
    )
    .replace("\"id\":\"b\"", "\"id\":\"c\"");
    Mock::given(method("GET"))
        .and(path("/catalog.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(tampered))
        .mount(&server)
        .await;
    let status = installer.refresh_catalog().await;
    assert!(status.warning.unwrap().contains("signature"));
    assert_eq!(hub.list().len(), 1, "catalog unchanged");
    assert!(!dir.path().join("catalog.cache.json").exists());

    server.reset().await;
    let older = signed(
        vec![entry("z", "1.0.0", &[format!("{}/m", server.uri())], &data)],
        "2025-01-01T00:00:00Z",
    );
    Mock::given(method("GET"))
        .and(path("/catalog.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(older))
        .mount(&server)
        .await;
    let status = installer.refresh_catalog().await;
    assert!(status.warning.unwrap().contains("older"));
    assert_eq!(hub.list()[0].id, "a");
}

#[tokio::test]
async fn catalog_refresh_offline_keeps_the_current_catalog() {
    let data = body(100);
    let mut cfg = net();
    cfg.catalog_url = "http://127.0.0.1:1/catalog.json".into(); // nothing listens here
    let dir = tempfile::tempdir().unwrap();
    let cur = signed(
        vec![entry(
            "a",
            "1.0.0",
            &["http://127.0.0.1:1/m".to_string()],
            &data,
        )],
        "2026-02-01T00:00:00Z",
    );
    let (hub, installer, _) = build(dir.path(), &cur, cfg);
    let status = installer.refresh_catalog().await;
    assert!(status.warning.unwrap().contains("offline"));
    assert_eq!(hub.list().len(), 1);
}

/// Acceptance check for H1: a 300 MB model survives an interruption and installs.
/// Run with `cargo test --lib large_model -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "moves 300 MB through a local server"]
async fn large_model_survives_an_interruption_and_installs() {
    let data = body(300 * 1024 * 1024);
    let e = env(
        |u| vec![entry("big", "1.0.0", &[format!("{u}/big.onnx")], &data)],
        net(),
    )
    .await;
    let blob = Blob::new(data.clone());
    serve(&e.server, "/big.onnx", blob.clone()).await;

    // First run: stop after roughly a third, as if the app were killed.
    let cfg = net();
    let client = downloader::build_client(&cfg).unwrap();
    let staging = e.dir.path().join(".downloads/big-1.0.0");
    let part = staging.join("model.onnx.part");
    let ctl = downloader::Control::default();
    let stop_at = data.len() as u64 / 3;
    let url = format!("{}/big.onnx", e.server.uri());
    let mut cb = |done: u64, _| {
        if done >= stop_at {
            ctl.pause.store(true, Ordering::Relaxed);
        }
    };
    let out =
        downloader::download_url(&client, &cfg, &url, &part, data.len() as u64, &ctl, &mut cb)
            .await
            .unwrap();
    assert_eq!(out, downloader::Outcome::Paused);
    let kept = std::fs::metadata(&part).unwrap().len();
    println!("interrupted at {} MB", kept / 1_048_576);

    // "Restart": a new hub and installer find the partial file and resume it.
    let json = signed(
        vec![entry("big", "1.0.0", &[url], &data)],
        "2026-01-01T00:00:00Z",
    );
    let (hub, installer, _) = build(e.dir.path(), &json, net());
    assert_eq!(hub.state_of("big"), ModelState::Paused);
    installer.resume("big").unwrap();
    assert_eq!(wait_for(&hub, "big", is_final).await, ModelState::Installed);
    assert_eq!(
        blob.seen.lock().unwrap().last().unwrap().as_deref(),
        Some(format!("bytes={kept}-").as_str())
    );
    assert_eq!(
        hub.model_path("big").unwrap().metadata().unwrap().len(),
        data.len() as u64
    );
}

#[tokio::test]
async fn install_recommended_and_all_skip_what_cannot_or_need_not_be_installed() {
    let d = body(2000);
    let e = env(
        |u| {
            let url = [format!("{u}/m.onnx")];
            let mut optional = entry("opt", "1.0.0", &url, &d);
            optional["recommended"] = false.into();
            let mut unpublished = entry("soon", "1.0.0", &url, &d);
            unpublished["sha256"] = crate::model_hub::config::PLACEHOLDER_SHA256.into();
            vec![entry("rec", "1.0.0", &url, &d), optional, unpublished]
        },
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(d)).await;

    assert_eq!(e.installer.install_recommended().unwrap(), 1);
    wait_for(&e.hub, "rec", is_final).await;
    assert!(
        !e.hub.is_ready("opt"),
        "optional models are not recommended"
    );
    assert_eq!(
        e.installer.install_recommended().unwrap(),
        0,
        "nothing left to do"
    );

    assert_eq!(e.installer.install_all().unwrap(), 1);
    wait_for(&e.hub, "opt", is_final).await;
    assert!(e.hub.is_ready("opt"));
    assert_eq!(e.hub.state_of("soon"), ModelState::NotInstalled);
}

// ---- Phase H3: import, remove, update, advanced settings, session cache -----------------------

use crate::model_hub::session_cache::SessionCache;

/// Records every `invalidate(id)` and whether the model's file still existed at that moment.
fn watch_unloads(hub: &ModelHub) -> Arc<Mutex<Vec<(String, bool)>>> {
    let seen: Arc<Mutex<Vec<(String, bool)>>> = Default::default();
    let log = seen.clone();
    let hub_dir = hub.models_dir().to_path_buf();
    hub.add_unload_hook(Arc::new(move |id| {
        let existed = std::fs::read_dir(hub_dir.join(id))
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        log.lock().unwrap().push((id.to_string(), existed));
    }));
    seen
}

async fn installed_env(data: &[u8]) -> Env {
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], data)],
        net(),
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(data.to_vec())).await;
    e.installer.install("a").unwrap();
    wait_for(&e.hub, "a", is_final).await;
    assert!(e.hub.is_ready("a"));
    e
}

#[tokio::test]
async fn remove_unloads_first_then_deletes_and_reinstall_works() {
    let data = body(30_000);
    let e = installed_env(&data).await;
    let unloads = watch_unloads(&e.hub);

    e.installer.remove("a").unwrap();
    assert_eq!(e.hub.state_of("a"), ModelState::NotInstalled);
    assert!(e.hub.model_path("a").is_err());
    assert!(!e.dir.path().join("a").exists());
    assert_eq!(
        unloads.lock().unwrap().as_slice(),
        [("a".to_string(), true)],
        "sessions are dropped while the file still exists"
    );
    assert_eq!(states(&e.events, "a").last().unwrap(), "notInstalled");
    assert!(states(&e.events, "a").contains(&"removing".to_string()));

    // The registry forgot it too: a restart agrees.
    let (hub2, _, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{}/m.onnx", e.server.uri())],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    assert_eq!(hub2.state_of("a"), ModelState::NotInstalled);

    e.installer.install("a").unwrap();
    assert_eq!(wait_for(&e.hub, "a", is_final).await, ModelState::Installed);
    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), data);
}

#[tokio::test]
async fn remove_refuses_busy_models_and_ignores_missing_ones() {
    let data = body(1000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    assert!(
        e.installer.remove("a").is_ok(),
        "nothing to remove is not an error"
    );
    assert!(e.installer.remove("zzz").is_err());
    e.hub.transition("a", ModelState::Queued).unwrap();
    let err = e.installer.remove("a").unwrap_err();
    assert_eq!(err.code(), "InvalidInput");
}

#[tokio::test]
async fn bundled_models_cannot_be_removed() {
    let dir = tempfile::tempdir().unwrap();
    let res = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(res.path().join("models")).unwrap();
    std::fs::write(res.path().join("models/isnet-general-use-fp16.onnx"), b"x").unwrap();
    let data = body(10);
    let catalog = signed(
        vec![entry(
            crate::model_hub::hub::BG_FAST,
            "1.0.0",
            &["http://127.0.0.1:1/m".to_string()],
            &data,
        )],
        "2026-01-01T00:00:00Z",
    );
    let hub = Arc::new(ModelHub::with_catalog_opts(
        dir.path().to_path_buf(),
        ModelManager::new(None, Some(res.path().to_path_buf())),
        Arc::new(|_, _| {}),
        &catalog,
        &sk().verifying_key().to_bytes(),
        false,
    ));
    let installer = Installer::new(hub.clone(), net(), Handle::current()).unwrap();
    let err = installer
        .remove(crate::model_hub::hub::BG_FAST)
        .unwrap_err();
    assert_eq!(err.code(), "Permission");
    assert!(hub.is_ready(crate::model_hub::hub::BG_FAST));
}

#[tokio::test]
async fn an_update_lets_go_of_sessions_before_the_old_version_is_deleted() {
    let v1 = body(5_000);
    let v2 = body(6_000);
    let e = installed_env(&v1).await;
    let unloads = watch_unloads(&e.hub);

    let json2 = signed(
        vec![entry(
            "a",
            "1.1.0",
            &[format!("{}/m2.onnx", e.server.uri())],
            &v2,
        )],
        "2026-02-01T00:00:00Z",
    );
    let cat =
        manifest::parse_verified_opts(&json2, &sk().verifying_key().to_bytes(), false).unwrap();
    e.hub.set_catalog(cat, &json2).unwrap();
    serve(&e.server, "/m2.onnx", Blob::new(v2.clone())).await;
    e.installer.install("a").unwrap();
    wait_for(&e.hub, "a", |s| *s == ModelState::Installed).await;

    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), v2);
    assert!(!e.dir.path().join("a/1.0.0").exists());
    let seen = unloads.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "a");
}

#[tokio::test]
async fn the_session_cache_reuses_replaces_and_evicts() {
    let v1 = body(5_000);
    let v2 = body(6_000);
    let e = installed_env(&v1).await;
    let cache: Arc<SessionCache<String>> = Arc::new(SessionCache::default());
    let evict = cache.clone();
    e.hub.add_unload_hook(Arc::new(move |id| evict.evict(id)));
    let loads = Arc::new(AtomicUsize::new(0));
    let get = |variant: &str| {
        let n = loads.clone();
        cache
            .get(&e.hub, "a", variant, move |p| {
                n.fetch_add(1, Ordering::SeqCst);
                Ok(p.display().to_string())
            })
            .map(|s| s.lock().unwrap().clone())
    };

    let first = get("cpu").unwrap();
    assert_eq!(get("cpu").unwrap(), first);
    assert_eq!(loads.load(Ordering::SeqCst), 1, "warm session is reused");
    get("gpu").unwrap();
    assert_eq!(
        loads.load(Ordering::SeqCst),
        2,
        "another device builds another session"
    );

    // An update swaps the file and drops the cached session, so the next use reloads the new one.
    let json2 = signed(
        vec![entry(
            "a",
            "1.1.0",
            &[format!("{}/m2.onnx", e.server.uri())],
            &v2,
        )],
        "2026-02-01T00:00:00Z",
    );
    let cat =
        manifest::parse_verified_opts(&json2, &sk().verifying_key().to_bytes(), false).unwrap();
    e.hub.set_catalog(cat, &json2).unwrap();
    serve(&e.server, "/m2.onnx", Blob::new(v2)).await;
    e.installer.install("a").unwrap();
    wait_for(&e.hub, "a", |s| *s == ModelState::Installed).await;
    assert!(!cache.contains("a"));
    let after = get("gpu").unwrap();
    assert!(after.contains("1.1.0"), "{after}");

    // Removal evicts, and a missing model is a typed error carrying its id.
    e.installer.remove("a").unwrap();
    assert!(!cache.contains("a"));
    let err = get("gpu").unwrap_err();
    assert_eq!(err.code(), "ModelMissing");
    assert!(err.to_string().contains('a'));
}

fn write_file(dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p.display().to_string()
}

#[tokio::test]
async fn importing_a_file_that_matches_the_catalog_is_verified() {
    let data = body(40_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/never")], &data)],
        net(),
    )
    .await;
    let unloads = watch_unloads(&e.hub);
    let src = tempfile::tempdir().unwrap();
    let path = write_file(src.path(), "my-model.onnx", &data);

    e.installer.import_file("a", &path, false).await.unwrap();
    assert_eq!(e.hub.state_of("a"), ModelState::Installed);
    assert_eq!(std::fs::read(e.hub.model_path("a").unwrap()).unwrap(), data);
    let info = &e.hub.list()[0];
    assert!(info.verified);
    assert_eq!(
        info.source,
        Some(crate::model_hub::registry::ModelSource::Imported)
    );
    assert!(
        e.server.received_requests().await.unwrap().is_empty(),
        "nothing was downloaded"
    );
    assert_eq!(unloads.lock().unwrap().len(), 1);
    assert!(!e.dir.path().join(".downloads/a-1.0.0").exists());
    // It survives a restart.
    let (hub2, _, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &["http://127.0.0.1:1/x".to_string()],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    assert!(hub2.is_ready("a"));
}

#[tokio::test]
async fn an_unverified_file_needs_explicit_consent_and_stays_marked() {
    let data = body(40_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/never")], &data)],
        net(),
    )
    .await;
    let src = tempfile::tempdir().unwrap();
    let other = write_file(src.path(), "other.onnx", &body(39_999));

    let err = e
        .installer
        .import_file("a", &other, false)
        .await
        .unwrap_err();
    assert_eq!(err.code(), "Unverified");
    assert_eq!(
        e.hub.state_of("a"),
        ModelState::NotInstalled,
        "nothing moved"
    );
    assert!(e.hub.model_path("a").is_err());
    assert!(
        states(&e.events, "a").is_empty(),
        "no state churn before consent"
    );

    e.installer.import_file("a", &other, true).await.unwrap();
    assert_eq!(e.hub.state_of("a"), ModelState::Installed);
    let info = &e.hub.list()[0];
    assert!(!info.verified, "marked Unverified in the model list");
    assert_eq!(
        info.source,
        Some(crate::model_hub::registry::ModelSource::Imported)
    );
    assert_eq!(
        std::fs::read(e.hub.model_path("a").unwrap()).unwrap(),
        body(39_999)
    );

    // The mark survives a restart.
    let (hub2, _, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &["http://127.0.0.1:1/x".to_string()],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    assert!(!hub2.list()[0].verified);
}

#[tokio::test]
async fn placeholder_catalog_hashes_always_count_as_unverified() {
    let data = body(1000);
    let mut m = entry("a", "1.0.0", &["https://x.example/m".to_string()], &data);
    m["sha256"] = crate::model_hub::config::PLACEHOLDER_SHA256.into();
    m["files"][0]["sha256"] = crate::model_hub::config::PLACEHOLDER_SHA256.into();
    let e = env(|_| vec![m], net()).await;
    let src = tempfile::tempdir().unwrap();
    let path = write_file(src.path(), "m.onnx", &data);
    assert_eq!(
        e.installer
            .import_file("a", &path, false)
            .await
            .unwrap_err()
            .code(),
        "Unverified"
    );
    e.installer.import_file("a", &path, true).await.unwrap();
    assert!(!e.hub.list()[0].verified);
}

#[tokio::test]
async fn bad_imports_are_refused_without_side_effects() {
    let data = body(1000);
    let e = env(
        |u| {
            let mut z = entry("pkg", "1.0.0", &[format!("{u}/p.zip")], &data);
            z["format"] = "zip".into();
            vec![entry("a", "1.0.0", &[format!("{u}/m")], &data), z]
        },
        net(),
    )
    .await;
    let src = tempfile::tempdir().unwrap();
    let good = write_file(src.path(), "m.onnx", &data);
    let wrong_ext = write_file(src.path(), "m.txt", &data);
    let empty = write_file(src.path(), "empty.onnx", b"");

    let code = |r: AppResult<()>| r.unwrap_err().code();
    assert_eq!(
        code(e.installer.import_file("zzz", &good, true).await),
        "InvalidInput"
    );
    assert_eq!(
        code(
            e.installer
                .import_file("a", "/no/such/file.onnx", true)
                .await
        ),
        "InvalidInput"
    );
    assert_eq!(
        code(
            e.installer
                .import_file("a", &src.path().display().to_string(), true)
                .await
        ),
        "InvalidInput"
    );
    assert_eq!(
        code(e.installer.import_file("a", "relative.onnx", true).await),
        "InvalidInput"
    );
    assert_eq!(
        code(e.installer.import_file("a", &wrong_ext, true).await),
        "UnsupportedFormat"
    );
    assert_eq!(
        code(e.installer.import_file("a", &empty, true).await),
        "InvalidInput"
    );
    assert_eq!(
        code(e.installer.import_file("pkg", &good, true).await),
        "InvalidInput"
    );
    assert_eq!(e.hub.state_of("a"), ModelState::NotInstalled);
    assert!(!e.dir.path().join("a").exists());

    e.installer.import_file("a", &good, false).await.unwrap();
    assert_eq!(
        code(e.installer.import_file("a", &good, true).await),
        "InvalidInput",
        "already installed"
    );
}

#[tokio::test]
async fn an_import_that_runs_out_of_disk_leaves_nothing_behind() {
    let data = body(1000);
    let cfg = NetConfig {
        free_space: Arc::new(|_| 10),
        ..net()
    };
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m")], &data)],
        cfg,
    )
    .await;
    let src = tempfile::tempdir().unwrap();
    let good = write_file(src.path(), "m.onnx", &data);
    let err = e.installer.import_file("a", &good, true).await.unwrap_err();
    assert_eq!(err.code(), "DiskFull");
    assert_eq!(e.hub.state_of("a"), ModelState::NotInstalled);
}

#[tokio::test]
async fn an_imported_model_can_be_removed_and_imported_again() {
    let data = body(2000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m")], &data)],
        net(),
    )
    .await;
    let src = tempfile::tempdir().unwrap();
    let good = write_file(src.path(), "m.onnx", &data);
    e.installer.import_file("a", &good, false).await.unwrap();
    e.installer.remove("a").unwrap();
    assert!(
        std::path::Path::new(&good).is_file(),
        "the user's own file is never touched"
    );
    e.installer.import_file("a", &good, false).await.unwrap();
    assert!(e.hub.is_ready("a"));
}

#[tokio::test]
async fn advanced_overrides_extend_the_allowlist_and_can_be_reset() {
    let data = body(3000);
    let cfg = NetConfig {
        allowed_hosts: vec!["models.photom.example".into()],
        ..net()
    };
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        cfg,
    )
    .await;
    serve(&e.server, "/m.onnx", Blob::new(data.clone())).await;

    // 127.0.0.1 is not on the list yet.
    e.installer.install("a").unwrap();
    let s = wait_for(&e.hub, "a", is_final).await;
    assert!(
        matches!(&s, ModelState::Failed { message, .. } if message.contains("not allowed")),
        "{s:?}"
    );

    // The user adds it in Advanced settings; retry works.
    e.installer
        .apply_overrides(None, Some(" 127.0.0.1 "))
        .unwrap();
    e.installer.install("a").unwrap();
    assert_eq!(
        wait_for(&e.hub, "a", |s| *s == ModelState::Installed).await,
        ModelState::Installed
    );
}

#[tokio::test]
async fn advanced_overrides_are_validated_and_resettable() {
    let data = body(10);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m")], &data)],
        net(),
    )
    .await;
    let base_url = e.installer.net().0.catalog_url;

    // http and junk are ignored, never half-applied.
    e.installer
        .apply_overrides(
            Some("http://insecure.example/c.json"),
            Some("https://x.example/p"),
        )
        .unwrap();
    let (cfg, _) = e.installer.net();
    assert_eq!(cfg.catalog_url, base_url);
    assert_eq!(cfg.allowed_hosts, vec!["127.0.0.1".to_string()]);

    e.installer
        .apply_overrides(Some("https://mirror.example/c.json"), Some("Files.Example"))
        .unwrap();
    let (cfg, _) = e.installer.net();
    assert_eq!(cfg.catalog_url, "https://mirror.example/c.json");
    assert!(
        cfg.allowed_hosts.contains(&"mirror.example".to_string()),
        "the catalog host is allowed"
    );
    assert!(cfg.allowed_hosts.contains(&"files.example".to_string()));

    e.installer.apply_overrides(None, None).unwrap();
    let (cfg, _) = e.installer.net();
    assert_eq!(cfg.catalog_url, base_url);
    assert_eq!(cfg.allowed_hosts, vec!["127.0.0.1".to_string()]);
}

// ---- Phase H4: end to end with a real ONNX model, offline behaviour ----------------------------

/// A valid ONNX model made of one `Identity` node on a float[4] tensor, written as raw protobuf
/// so the test needs no Python or model files.
fn identity_onnx() -> Vec<u8> {
    fn varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    fn field_varint(field: u64, v: u64, out: &mut Vec<u8>) {
        varint(field << 3, out);
        varint(v, out);
    }
    fn field_bytes(field: u64, b: &[u8], out: &mut Vec<u8>) {
        varint((field << 3) | 2, out);
        varint(b.len() as u64, out);
        out.extend_from_slice(b);
    }
    let value_info = |name: &str| {
        let mut dim = Vec::new();
        field_varint(1, 4, &mut dim); // dim_value = 4
        let mut shape = Vec::new();
        field_bytes(1, &dim, &mut shape);
        let mut tensor = Vec::new();
        field_varint(1, 1, &mut tensor); // elem_type = FLOAT
        field_bytes(2, &shape, &mut tensor);
        let mut ty = Vec::new();
        field_bytes(1, &tensor, &mut ty);
        let mut vi = Vec::new();
        field_bytes(1, name.as_bytes(), &mut vi);
        field_bytes(2, &ty, &mut vi);
        vi
    };
    let mut node = Vec::new();
    field_bytes(1, b"x", &mut node);
    field_bytes(2, b"y", &mut node);
    field_bytes(4, b"Identity", &mut node);
    let mut graph = Vec::new();
    field_bytes(1, &node, &mut graph);
    field_bytes(2, b"identity", &mut graph);
    field_bytes(11, &value_info("x"), &mut graph);
    field_bytes(12, &value_info("y"), &mut graph);
    let mut opset = Vec::new();
    field_varint(2, 13, &mut opset);
    let mut model = Vec::new();
    field_varint(1, 8, &mut model); // ir_version
    field_bytes(8, &opset, &mut model);
    field_bytes(7, &graph, &mut model);
    model
}

fn run_identity(session: &Mutex<ort::session::Session>) -> Vec<f32> {
    let mut s = session.lock().unwrap();
    let input = ort::value::Tensor::from_array(([4usize], vec![1.0f32, 2.0, 3.0, 4.0])).unwrap();
    let out = s.run(ort::inputs!["x" => input]).unwrap();
    let (_, data) = out[0].try_extract_tensor::<f32>().unwrap();
    data.to_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_model_installed_through_the_hub_loads_and_runs_with_the_network_gone() {
    use crate::models::dto::DevicePref;
    use crate::services::inference::open_session;

    let onnx = identity_onnx();
    let dir = tempfile::tempdir().unwrap();
    let loader = |p: &std::path::Path| open_session(p, DevicePref::Cpu).map(|(s, _)| s);

    // 1. Install through the real pipeline: signed catalog -> download -> verify -> atomic install.
    let server = MockServer::start().await;
    let json = signed(
        vec![entry(
            "tiny",
            "1.0.0",
            &[format!("{}/m.onnx", server.uri())],
            &onnx,
        )],
        "2026-01-01T00:00:00Z",
    );
    serve(&server, "/m.onnx", Blob::new(onnx.clone())).await;
    let (hub, installer, _) = build(dir.path(), &json, net());
    installer.install("tiny").unwrap();
    assert_eq!(
        wait_for(&hub, "tiny", is_final).await,
        ModelState::Installed
    );
    let requests_while_installing = server.received_requests().await.unwrap().len();
    assert_eq!(requests_while_installing, 1);

    // 2. Features reach the model through the session cache and it really runs.
    let cache: SessionCache<ort::session::Session> = SessionCache::default();
    let session = cache.get(&hub, "tiny", "cpu", loader).unwrap();
    assert_eq!(run_identity(&session), vec![1.0, 2.0, 3.0, 4.0]);
    cache.clear();
    drop(session);

    // 3. "Network disabled": the server is gone and the app restarts with unreachable URLs.
    drop(server);
    let mut dead = net();
    dead.catalog_url = "http://127.0.0.1:1/catalog.json".into();
    let offline_json = signed(
        vec![entry(
            "tiny",
            "1.0.0",
            &["http://127.0.0.1:1/m.onnx".to_string()],
            &onnx,
        )],
        "2026-01-01T00:00:00Z",
    );
    let (hub2, installer2, events2) = build(dir.path(), &offline_json, dead);
    assert_eq!(hub2.state_of("tiny"), ModelState::Installed);
    assert!(hub2.check_requirements("f").unwrap().ready);
    let session = cache.get(&hub2, "tiny", "cpu", loader).unwrap();
    assert_eq!(run_identity(&session), vec![1.0, 2.0, 3.0, 4.0]);

    // Nothing in this path tried to reach the network; only an explicit refresh does, and it
    // fails gracefully without touching what is installed.
    assert!(events2
        .lock()
        .unwrap()
        .iter()
        .all(|(n, _)| n != "model:error"));
    let status = installer2.refresh_catalog().await;
    assert!(status.warning.is_some());
    assert_eq!(hub2.state_of("tiny"), ModelState::Installed);
    assert_eq!(run_identity(&session), vec![1.0, 2.0, 3.0, 4.0]);
    cache.clear();
}

#[tokio::test]
async fn starting_up_and_listing_models_never_touches_the_network() {
    let data = body(1000);
    let e = installed_env(&data).await;
    let before = e.server.received_requests().await.unwrap().len();
    // A fresh start, listing, requirement checks and state queries.
    let (hub2, _installer2, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{}/m.onnx", e.server.uri())],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    let _ = hub2.list();
    let _ = hub2.check_requirements("f");
    let _ = hub2.catalog_status();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(e.server.received_requests().await.unwrap().len(), before);
}

#[tokio::test]
async fn paused_downloads_do_not_resume_by_themselves_after_a_restart() {
    let data = body(50_000);
    let e = env(
        |u| vec![entry("a", "1.0.0", &[format!("{u}/m.onnx")], &data)],
        net(),
    )
    .await;
    let staging = e.dir.path().join(".downloads/a-1.0.0");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("model.onnx.part"), &data[..1000]).unwrap();
    let (hub, _installer, _) = build(
        e.dir.path(),
        &signed(
            vec![entry(
                "a",
                "1.0.0",
                &[format!("{}/m.onnx", e.server.uri())],
                &data,
            )],
            "2026-01-01T00:00:00Z",
        ),
        net(),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        hub.state_of("a"),
        ModelState::Paused,
        "waits for the user (no surprise downloads)"
    );
    assert!(e.server.received_requests().await.unwrap().is_empty());
}
