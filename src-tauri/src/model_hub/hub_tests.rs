use super::*;
use crate::model_hub::manifest::canonical_json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

fn sk() -> SigningKey {
    SigningKey::from_bytes(&[3u8; 32])
}

fn entry(id: &str, feature: &str, recommended: bool, deps: &[&str]) -> Value {
    json!({
        "id": id, "name": id, "feature": feature, "version": "1.0.0", "description": "",
        "sizeBytes": 10, "sha256": "ab".repeat(32), "format": "onnx",
        "files": [{ "path": "model.onnx", "sizeBytes": 10, "sha256": "ab".repeat(32) }],
        "urls": ["https://models.photom.example/x"],
        "license": { "name": "MIT", "url": "https://x.example", "commercialUse": true, "attribution": "" },
        "requirements": { "minRamMb": 1, "gpuOptional": true },
        "runtime": { "inputSize": [1, 1], "normalization": "none", "notes": "" },
        "recommended": recommended, "dependsOn": deps,
    })
}

fn catalog(models: Vec<Value>) -> String {
    let models = Value::Array(models);
    let sig = sk().sign(canonical_json(&models).as_bytes());
    json!({
        "schemaVersion": 1, "generatedAt": "2026-01-01T00:00:00Z",
        "models": models, "signature": STANDARD.encode(sig.to_bytes()),
    })
    .to_string()
}

struct Fixture {
    dir: tempfile::TempDir,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Fixture {
    fn hub(&self, models: Vec<Value>) -> ModelHub {
        let events = self.events.clone();
        ModelHub::with_catalog(
            self.dir.path().to_path_buf(),
            ModelManager::new(None, None),
            Arc::new(move |n, p| events.lock().unwrap().push((n.to_string(), p))),
            &catalog(models),
            &sk().verifying_key().to_bytes(),
        )
    }
}

fn fixture() -> Fixture {
    Fixture {
        dir: tempfile::tempdir().unwrap(),
        events: Default::default(),
    }
}

fn install(dir: &std::path::Path, id: &str, version: &str) {
    let rel = format!("{id}/{version}/model.onnx");
    let full = dir.join(&rel);
    std::fs::create_dir_all(full.parent().unwrap()).unwrap();
    std::fs::write(&full, b"weights").unwrap();
    let mut reg = Registry::load(dir);
    reg.upsert(InstalledRecord {
        id: id.into(),
        version: version.into(),
        source: ModelSource::Hub,
        path: rel,
        sha256: None,
        installed_at: Utc::now(),
        verified: true,
    })
    .unwrap();
}

#[test]
fn the_upscaler_models_ship_with_the_app_and_count_as_installed() {
    let f = fixture();
    let hub = ModelHub::new(
        f.dir.path().to_path_buf(),
        ModelManager::new(None, None),
        Arc::new(|_, _| {}),
    );
    for id in ["upscale-x2", "upscale-x4"] {
        assert!(hub.is_ready(id), "{id} should be installed from the bundle");
        assert!(hub.model_path(id).unwrap().is_file());
    }
    assert!(hub.check_models(&["upscale-x4".into()]).ready);
}

#[test]
fn the_bundled_catalog_loads_in_production_mode() {
    let f = fixture();
    let hub = ModelHub::new(
        f.dir.path().to_path_buf(),
        ModelManager::new(None, None),
        Arc::new(|_, _| {}),
    );
    let list = hub.list();
    assert_eq!(list.len(), 7);
    assert_eq!(hub.catalog_status().source, CatalogSource::Bundled);
    assert!(hub.catalog_status().warning.is_none());
}

#[test]
fn a_tampered_bundled_catalog_yields_an_empty_list_and_a_warning() {
    let f = fixture();
    let tampered =
        catalog(vec![entry("a", "f", true, &[])]).replace("\"sizeBytes\":10", "\"sizeBytes\":99");
    let hub = ModelHub::with_catalog(
        f.dir.path().to_path_buf(),
        ModelManager::new(None, None),
        Arc::new(|_, _| {}),
        &tampered,
        &sk().verifying_key().to_bytes(),
    );
    assert!(hub.list().is_empty());
    assert!(hub.catalog_status().warning.unwrap().contains("signature"));
}

#[test]
fn not_installed_until_a_record_and_file_exist() {
    let f = fixture();
    let hub = f.hub(vec![entry("a", "f", true, &[])]);
    assert_eq!(hub.state_of("a"), ModelState::NotInstalled);
    assert_eq!(hub.model_path("a").unwrap_err().code(), "ModelMissing");
    install(f.dir.path(), "a", "1.0.0");
    let hub = f.hub(vec![entry("a", "f", true, &[])]);
    assert_eq!(hub.state_of("a"), ModelState::Installed);
    assert!(hub.model_path("a").unwrap().is_file());
}

#[test]
fn installed_state_persists_across_restarts_and_notices_deleted_files() {
    let f = fixture();
    install(f.dir.path(), "a", "1.0.0");
    assert_eq!(
        f.hub(vec![entry("a", "f", true, &[])]).state_of("a"),
        ModelState::Installed
    );
    std::fs::remove_file(f.dir.path().join("a/1.0.0/model.onnx")).unwrap();
    assert_eq!(
        f.hub(vec![entry("a", "f", true, &[])]).state_of("a"),
        ModelState::NotInstalled
    );
}

#[test]
fn a_newer_catalog_version_shows_update_available_but_stays_usable() {
    let f = fixture();
    install(f.dir.path(), "a", "1.0.0");
    let mut e = entry("a", "f", true, &[]);
    e["version"] = "1.1.0".into();
    let hub = f.hub(vec![e]);
    assert_eq!(hub.state_of("a"), ModelState::UpdateAvailable);
    assert!(hub.is_ready("a"));
    let info = &hub.list()[0];
    assert_eq!(info.installed_version.as_deref(), Some("1.0.0"));
    assert!(info.removable);
}

#[test]
fn transitions_are_validated_and_emit_events() {
    let f = fixture();
    let hub = f.hub(vec![entry("a", "f", true, &[])]);
    assert!(
        hub.transition("a", ModelState::Downloading).is_err(),
        "must queue first"
    );
    hub.transition("a", ModelState::Queued).unwrap();
    hub.transition("a", ModelState::Downloading).unwrap();
    assert_eq!(hub.state_of("a"), ModelState::Downloading);
    hub.transition("a", ModelState::Paused).unwrap();
    hub.transition("a", ModelState::Downloading).unwrap();
    hub.transition("a", ModelState::Verifying).unwrap();
    hub.transition("a", ModelState::Installing).unwrap();
    let rel = "a/1.0.0/model.onnx";
    std::fs::create_dir_all(f.dir.path().join("a/1.0.0")).unwrap();
    std::fs::write(f.dir.path().join(rel), b"w").unwrap();
    hub.register(InstalledRecord {
        id: "a".into(),
        version: "1.0.0".into(),
        source: ModelSource::Hub,
        path: rel.into(),
        sha256: None,
        installed_at: Utc::now(),
        verified: true,
    })
    .unwrap();
    assert_eq!(
        hub.transition("a", ModelState::Installed).unwrap(),
        ModelState::Installed
    );
    assert_eq!(hub.state_of("a"), ModelState::Installed);
    let events = f.events.lock().unwrap();
    assert_eq!(events.len(), 7);
    assert!(events.iter().all(|(n, _)| n == "model:state"));
    assert_eq!(events[0].1["id"], "a");
    assert_eq!(events[0].1["state"]["kind"], "queued");
}

#[test]
fn cancelling_falls_back_to_the_registry_state() {
    let f = fixture();
    let hub = f.hub(vec![entry("a", "f", true, &[])]);
    hub.transition("a", ModelState::Queued).unwrap();
    hub.transition("a", ModelState::Downloading).unwrap();
    assert_eq!(
        hub.transition("a", ModelState::NotInstalled).unwrap(),
        ModelState::NotInstalled
    );
    assert_eq!(hub.state_of("a"), ModelState::NotInstalled);
}

#[test]
fn failures_carry_a_code_and_can_be_retried() {
    let f = fixture();
    let hub = f.hub(vec![entry("a", "f", true, &[])]);
    hub.transition("a", ModelState::Queued).unwrap();
    hub.transition(
        "a",
        ModelState::Failed {
            code: "Io".into(),
            message: "disk full".into(),
        },
    )
    .unwrap();
    assert!(matches!(hub.state_of("a"), ModelState::Failed { .. }));
    hub.transition("a", ModelState::Queued).unwrap();
}

#[test]
fn unknown_models_are_rejected() {
    let f = fixture();
    let hub = f.hub(vec![entry("a", "f", true, &[])]);
    assert_eq!(
        hub.transition("zzz", ModelState::Queued)
            .unwrap_err()
            .code(),
        "InvalidInput"
    );
}

#[test]
fn requirements_include_recommended_models_and_dependencies() {
    let f = fixture();
    let models = vec![
        entry("det", "text", true, &[]),
        entry("fill", "text", true, &["helper"]),
        entry("helper", "other", false, &[]),
        entry("extra", "text", false, &[]),
    ];
    let hub = f.hub(models.clone());
    let r = hub.check_requirements("text").unwrap();
    assert!(!r.ready);
    let mut ids: Vec<_> = r.missing.iter().map(|m| m.id.as_str()).collect();
    ids.sort();
    assert_eq!(
        ids,
        ["det", "fill", "helper"],
        "optional 'extra' is not required"
    );

    for id in ["det", "fill", "helper"] {
        install(f.dir.path(), id, "1.0.0");
    }
    let hub = f.hub(models);
    let r = hub.check_requirements("text").unwrap();
    assert!(r.ready && r.missing.is_empty());
    assert_eq!(
        hub.check_requirements("nope").unwrap_err().code(),
        "InvalidInput"
    );
}

#[test]
fn the_bundled_background_model_is_registered_and_not_removable() {
    let f = fixture();
    let res = tempfile::tempdir().unwrap();
    std::fs::write(res.path().join("isnet-general-use-fp16.onnx"), b"x").unwrap();
    let locator = ModelManager::new(None, Some(res.path().to_path_buf()));
    // `ModelManager::new` looks in <resource_dir>/models.
    std::fs::create_dir_all(res.path().join("models")).unwrap();
    std::fs::rename(
        res.path().join("isnet-general-use-fp16.onnx"),
        res.path().join("models/isnet-general-use-fp16.onnx"),
    )
    .unwrap();
    let hub = ModelHub::with_catalog(
        f.dir.path().to_path_buf(),
        locator,
        Arc::new(|_, _| {}),
        &catalog(vec![
            entry(BG_FAST, "background-removal", true, &[]),
            entry(BG_QUALITY, "background-removal", false, &[]),
        ]),
        &sk().verifying_key().to_bytes(),
    );
    let fast = hub.list().into_iter().find(|m| m.id == BG_FAST).unwrap();
    assert_eq!(fast.state, ModelState::Installed);
    assert_eq!(fast.source, Some(ModelSource::Bundled));
    assert!(!fast.removable && fast.verified);
    let quality = hub.list().into_iter().find(|m| m.id == BG_QUALITY).unwrap();
    assert_eq!(quality.state, ModelState::NotInstalled);
    assert!(hub.check_requirements("background-removal").unwrap().ready);
}
