use super::*;

fn record(id: &str) -> InstalledRecord {
    InstalledRecord {
        id: id.into(),
        version: "1.0.0".into(),
        source: ModelSource::Hub,
        path: format!("{id}/1.0.0/model.onnx"),
        sha256: Some("ab".repeat(32)),
        installed_at: Utc::now(),
        verified: true,
    }
}

#[test]
fn records_persist_across_a_reload() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = Registry::load(dir.path());
    assert!(r.all().is_empty());
    r.upsert(record("a")).unwrap();
    r.upsert(record("b")).unwrap();
    let again = Registry::load(dir.path());
    assert_eq!(again.all().len(), 2);
    assert_eq!(again.get("a").unwrap().version, "1.0.0");
}

#[test]
fn upsert_replaces_and_remove_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = Registry::load(dir.path());
    r.upsert(record("a")).unwrap();
    let mut newer = record("a");
    newer.version = "1.1.0".into();
    r.upsert(newer).unwrap();
    assert_eq!(r.all().len(), 1);
    assert_eq!(
        Registry::load(dir.path()).get("a").unwrap().version,
        "1.1.0"
    );
    assert!(r.remove("a").unwrap().is_some());
    assert!(r.remove("a").unwrap().is_none());
    assert!(Registry::load(dir.path()).all().is_empty());
}

#[test]
fn a_corrupt_registry_is_set_aside_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(REGISTRY_FILE), b"{ nope").unwrap();
    let r = Registry::load(dir.path());
    assert!(r.all().is_empty());
    assert!(dir.path().join("registry.json.corrupt").is_file());
}

#[test]
fn no_temp_file_is_left_behind() {
    let dir = tempfile::tempdir().unwrap();
    Registry::load(dir.path()).upsert(record("a")).unwrap();
    assert!(!dir.path().join("registry.json.tmp").exists());
}

#[test]
fn hostile_record_paths_do_not_resolve() {
    let dir = Path::new("/models");
    let mut r = record("a");
    assert!(resolve_path(dir, &r).is_some());
    r.path = "../../etc/passwd".into();
    assert!(resolve_path(dir, &r).is_none());
    r.path = "/etc/passwd".into();
    assert!(resolve_path(dir, &r).is_none());
    r.source = ModelSource::Bundled;
    assert_eq!(resolve_path(dir, &r), Some(PathBuf::from("/etc/passwd")));
}

fn failed() -> ModelState {
    ModelState::Failed {
        code: "Io".into(),
        message: "x".into(),
    }
}

#[test]
fn the_happy_path_is_legal() {
    use ModelState::*;
    let chain = [
        NotInstalled,
        Queued,
        Downloading,
        Verifying,
        Installing,
        Installed,
    ];
    for pair in chain.windows(2) {
        assert!(
            pair[0].can_become(&pair[1]),
            "{:?} -> {:?}",
            pair[0],
            pair[1]
        );
    }
}

#[test]
fn pause_resume_cancel_and_failure() {
    use ModelState::*;
    assert!(Downloading.can_become(&Paused));
    assert!(Paused.can_become(&Downloading));
    assert!(Paused.can_become(&Queued));
    assert!(Downloading.can_become(&failed()));
    assert!(failed().can_become(&Queued), "retry");
    assert!(
        Downloading.can_become(&NotInstalled),
        "cancel falls back to rest"
    );
    assert!(Queued.can_become(&NotInstalled));
}

#[test]
fn illegal_jumps_are_refused() {
    use ModelState::*;
    assert!(!NotInstalled.can_become(&Downloading));
    assert!(!NotInstalled.can_become(&Installed));
    assert!(!Installed.can_become(&Queued));
    assert!(!Installed.can_become(&Downloading));
    assert!(Verifying.can_become(&Downloading), "next mirror or file");
    assert!(!Verifying.can_become(&Paused));
    assert!(!Installing.can_become(&Paused));
    assert!(UpdateAvailable.can_become(&Queued));
    assert!(Installed.can_become(&Removing));
    assert!(Removing.can_become(&NotInstalled));
}
