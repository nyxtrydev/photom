//! Install pipeline and queue: download (resume, mirrors) -> verify -> extract -> atomic install.
//! One model is processed at a time; the rest wait in the queue.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use tokio::runtime::Handle;

use super::archive::extract_zip;
use super::config;
use super::downloader::{self, download_url, Control, NetConfig, Outcome};
use super::hub::{CatalogStatus, ModelHub};
use super::manifest::{self, CatalogFile, CatalogModel};
use super::registry::{InstalledRecord, ModelSource, ModelState};
use super::verifier::verify_file;
use crate::models::error::{AppError, AppResult};

const DOWNLOADS_DIR: &str = ".downloads";
const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
struct Inner {
    queue: VecDeque<String>,
    controls: HashMap<String, Arc<Control>>,
    worker_running: bool,
}

/// Network settings and the client built from them; replaced when the user changes the
/// Advanced settings.
struct Net {
    cfg: NetConfig,
    client: Client,
}

pub struct Installer {
    hub: Arc<ModelHub>,
    /// The configuration before any user override.
    base: NetConfig,
    net: RwLock<Net>,
    handle: Handle,
    inner: Mutex<Inner>,
}

enum Finished {
    Installed,
    Paused,
    Cancelled,
}

pub fn staging_dir(models_dir: &Path, model: &CatalogModel) -> PathBuf {
    models_dir
        .join(DOWNLOADS_DIR)
        .join(format!("{}-{}", model.id, model.version))
}

fn total_bytes(model: &CatalogModel) -> u64 {
    model.files.iter().map(|f| f.size_bytes).sum()
}

fn is_zip(model: &CatalogModel) -> bool {
    model.format == "zip"
}

/// The file features load. Zip archives follow the `model.onnx` convention.
pub fn primary_file(model: &CatalogModel) -> String {
    if is_zip(model) {
        return "model.onnx".into();
    }
    model
        .files
        .iter()
        .find(|f| f.path == "model.onnx")
        .or(model.files.first())
        .map(|f| f.path.clone())
        .unwrap_or_default()
}

fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => total += dir_bytes(&e.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

impl Installer {
    pub fn new(hub: Arc<ModelHub>, cfg: NetConfig, handle: Handle) -> AppResult<Arc<Self>> {
        let client = downloader::build_client(&cfg)?;
        let me = Arc::new(Self {
            hub,
            base: cfg.clone(),
            net: RwLock::new(Net { cfg, client }),
            handle,
            inner: Mutex::new(Inner::default()),
        });
        me.restore_interrupted();
        Ok(me)
    }

    fn net(&self) -> (NetConfig, Client) {
        let n = self.net.read().unwrap_or_else(|p| p.into_inner());
        (n.cfg.clone(), n.client.clone())
    }

    /// Apply the Advanced settings: a different catalog URL and/or one extra download host. The
    /// catalog's own host is allowed automatically (the user chose it). Downloads are still only
    /// accepted from a signed catalog and verified against its hashes.
    pub fn apply_overrides(
        &self,
        catalog_url: Option<&str>,
        extra_host: Option<&str>,
    ) -> AppResult<()> {
        let mut cfg = self.base.clone();
        if let Some(h) = extra_host.and_then(config::clean_host) {
            cfg.allowed_hosts.push(h);
        }
        if let Some(u) = catalog_url.and_then(config::clean_catalog_url) {
            if let Some(host) = reqwest::Url::parse(&u)
                .ok()
                .and_then(|p| p.host_str().map(str::to_ascii_lowercase))
            {
                cfg.allowed_hosts.push(host);
            }
            cfg.catalog_url = u;
        }
        let client = downloader::build_client(&cfg)?;
        *self.net.write().unwrap_or_else(|p| p.into_inner()) = Net { cfg, client };
        Ok(())
    }

    /// Downloads cut short by an app exit or crash come back as Paused, ready to resume.
    fn restore_interrupted(&self) {
        for m in self.hub.catalog_models() {
            let leftover = dir_bytes(&staging_dir(self.hub.models_dir(), &m)) > 0;
            if leftover && !matches!(self.hub.state_of(&m.id), ModelState::Installed) {
                self.hub.restore_state(&m.id, ModelState::Paused);
            }
        }
    }

    fn move_to(&self, id: &str, state: ModelState) {
        if let Err(e) = self.hub.transition(id, state) {
            tracing::warn!(model = id, error = %e, "state change refused");
        }
    }

    /// Mark a model failed even if the machine would not allow it from where it is.
    fn force_failed(&self, id: &str, e: &AppError) {
        let state = ModelState::Failed {
            code: e.code().to_string(),
            message: e.to_string(),
        };
        self.hub.restore_state(id, state.clone());
        self.hub
            .emit("model:state", json!({ "id": id, "state": state }));
        self.hub.emit(
            "model:error",
            json!({ "id": id, "code": e.code(), "message": e.to_string() }),
        );
    }

    fn check_space(&self, model: &CatalogModel) -> AppResult<()> {
        let dir = self.hub.models_dir();
        std::fs::create_dir_all(dir)?;
        let existing = dir_bytes(&staging_dir(dir, model));
        let mut need = total_bytes(model).saturating_sub(existing);
        if is_zip(model) {
            need = need.saturating_mul(2); // archive plus extracted files
        }
        need += (need / 20).max(32 * 1024 * 1024);
        let free = (self.net().0.free_space)(dir);
        if free < need {
            return Err(AppError::DiskFull(format!(
                "needs about {} MB free, {} MB available",
                need.div_ceil(1_000_000),
                free / 1_000_000
            )));
        }
        Ok(())
    }

    /// Queue a model (and anything it depends on). Safe to call again while it is running.
    pub fn install(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let model = self
            .hub
            .catalog_model(id)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown model '{id}'")))?;
        match self.hub.state_of(id) {
            ModelState::Queued
            | ModelState::Downloading
            | ModelState::Verifying
            | ModelState::Installing
            | ModelState::Installed => return Ok(()),
            _ => {}
        }
        if !model.installable() {
            return Err(AppError::InvalidInput(format!(
                "{} is not available for download yet",
                model.name
            )));
        }
        for dep in &model.depends_on {
            if !self.hub.is_ready(dep) {
                self.install(dep)?;
            }
        }
        self.check_space(&model)?;
        self.hub.transition(id, ModelState::Queued)?;
        {
            let mut g = self.lock();
            g.controls
                .insert(id.to_string(), Arc::new(Control::default()));
            g.queue.push_back(id.to_string());
        }
        self.pump();
        Ok(())
    }

    /// Queue several models; returns how many were newly queued. Stops at the first error
    /// (typically `DiskFull`), leaving earlier ones queued.
    pub fn install_many(self: &Arc<Self>, ids: &[String]) -> AppResult<u32> {
        let mut queued = 0;
        for id in ids {
            let before = self.hub.state_of(id);
            self.install(id)?;
            if matches!(self.hub.state_of(id), ModelState::Queued)
                && !matches!(before, ModelState::Queued)
            {
                queued += 1;
            }
        }
        Ok(queued)
    }

    /// Everything recommended that can be downloaded and is not here yet.
    pub fn install_recommended(self: &Arc<Self>) -> AppResult<u32> {
        self.install_wanted(true)
    }

    pub fn install_all(self: &Arc<Self>) -> AppResult<u32> {
        self.install_wanted(false)
    }

    fn install_wanted(self: &Arc<Self>, recommended_only: bool) -> AppResult<u32> {
        let ids: Vec<String> = self
            .hub
            .catalog_models()
            .into_iter()
            .filter(|m| (m.recommended || !recommended_only) && m.installable())
            .filter(|m| !self.hub.is_ready(&m.id))
            .map(|m| m.id)
            .collect();
        self.install_many(&ids)
    }

    /// Resuming is the same as installing again: parts on disk are reused.
    pub fn resume(self: &Arc<Self>, id: &str) -> AppResult<()> {
        self.install(id)
    }

    pub fn pause(&self, id: &str) -> AppResult<()> {
        let mut g = self.lock();
        if let Some(pos) = g.queue.iter().position(|q| q == id) {
            g.queue.remove(pos);
            g.controls.remove(id);
            drop(g);
            return self.hub.transition(id, ModelState::Paused).map(|_| ());
        }
        if let Some(c) = g.controls.get(id) {
            c.pause.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> AppResult<()> {
        let model = self
            .hub
            .catalog_model(id)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown model '{id}'")))?;
        let mut g = self.lock();
        let queued = g.queue.iter().position(|q| q == id);
        if let Some(pos) = queued {
            g.queue.remove(pos);
        }
        if queued.is_none() {
            if let Some(c) = g.controls.get(id) {
                // A running job notices and cleans up itself.
                c.cancel.store(true, Ordering::Relaxed);
                return Ok(());
            }
        }
        g.controls.remove(id);
        drop(g);
        let _ = std::fs::remove_dir_all(staging_dir(self.hub.models_dir(), &model));
        match self.hub.state_of(id) {
            ModelState::Queued | ModelState::Paused | ModelState::Failed { .. } => self
                .hub
                .transition(id, ModelState::NotInstalled)
                .map(|_| ()),
            _ => Ok(()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn pump(self: &Arc<Self>) {
        {
            let mut g = self.lock();
            if g.worker_running {
                return;
            }
            g.worker_running = true;
        }
        let me = Arc::clone(self);
        self.handle.spawn(async move {
            loop {
                let next = {
                    let mut g = me.lock();
                    match g.queue.pop_front() {
                        Some(id) => {
                            let ctl = g.controls.get(&id).cloned();
                            Some((id, ctl))
                        }
                        None => {
                            g.worker_running = false;
                            None
                        }
                    }
                };
                let Some((id, Some(ctl))) = next else {
                    if next.is_none() {
                        break;
                    }
                    continue;
                };
                me.run_one(&id, &ctl).await;
                me.lock().controls.remove(&id);
            }
        });
    }

    async fn run_one(&self, id: &str, ctl: &Control) {
        let model = match self.hub.catalog_model(id) {
            Some(m) => m,
            None => return,
        };
        let outcome = self.execute(&model, ctl).await;
        let dir = staging_dir(self.hub.models_dir(), &model);
        match outcome {
            Ok(Finished::Installed) => {}
            Ok(Finished::Paused) => self.move_to(id, ModelState::Paused),
            Ok(Finished::Cancelled) | Err(AppError::Cancelled) => {
                let _ = std::fs::remove_dir_all(&dir);
                self.move_to(id, ModelState::NotInstalled);
            }
            Err(e) => {
                tracing::warn!(model = id, code = e.code(), "install failed");
                self.force_failed(id, &e);
            }
        }
    }

    fn urls_for(&self, model: &CatalogModel, file: &CatalogFile) -> Vec<String> {
        if model.files.len() == 1 {
            model.urls.clone()
        } else {
            model
                .urls
                .iter()
                .map(|u| format!("{}/{}", u.trim_end_matches('/'), file.path))
                .collect()
        }
    }

    async fn execute(&self, model: &CatalogModel, ctl: &Control) -> AppResult<Finished> {
        let id = model.id.as_str();
        self.hub.transition(id, ModelState::Downloading)?;
        self.check_space(model)?;
        let staging = staging_dir(self.hub.models_dir(), model);
        std::fs::create_dir_all(&staging)?;
        let total = total_bytes(model);
        let mut base = 0u64;
        for file in &model.files {
            match self
                .fetch_file(model, file, &staging, ctl, base, total)
                .await?
            {
                Outcome::Completed => base += file.size_bytes,
                Outcome::Paused => return Ok(Finished::Paused),
                Outcome::Cancelled => return Ok(Finished::Cancelled),
            }
        }
        if ctl.cancel.load(Ordering::Relaxed) {
            return Ok(Finished::Cancelled);
        }

        self.hub.transition(id, ModelState::Installing)?;
        let staged = staging.clone();
        let m = model.clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            if is_zip(&m) {
                for f in &m.files {
                    let archive = staged.join(&f.path);
                    extract_zip(&archive, &staged, super::config::MAX_MODEL_BYTES)?;
                    std::fs::remove_file(archive)?;
                }
            }
            if !staged.join(primary_file(&m)).is_file() {
                return Err(AppError::HashMismatch(format!(
                    "the package has no {}",
                    primary_file(&m)
                )));
            }
            let meta = json!({
                "id": m.id, "version": m.version, "sha256": m.sha256,
                "files": m.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
                "installedAt": chrono::Utc::now().to_rfc3339(),
            });
            std::fs::write(staged.join("meta.json"), meta.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;

        if ctl.cancel.load(Ordering::Relaxed) {
            return Ok(Finished::Cancelled);
        }
        self.commit(model, &staging, ModelSource::Hub, true, &model.sha256)?;
        self.move_to(id, ModelState::Installed);
        Ok(Finished::Installed)
    }

    /// Atomic swap into `<models>/<id>/<version>`; the registry write switches the model over.
    fn commit(
        &self,
        model: &CatalogModel,
        staging: &Path,
        source: ModelSource,
        verified: bool,
        sha256: &str,
    ) -> AppResult<()> {
        let models = self.hub.models_dir();
        let parent = models.join(&model.id);
        let target = parent.join(&model.version);
        std::fs::create_dir_all(&parent)?;
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(staging, &target)?;
        self.hub.register(InstalledRecord {
            id: model.id.clone(),
            version: model.version.clone(),
            source,
            path: format!("{}/{}/{}", model.id, model.version, primary_file(model)),
            sha256: Some(sha256.to_string()),
            installed_at: chrono::Utc::now(),
            verified,
        })?;
        // The registry now points at the new file. Anyone holding a session on the old one must
        // let go before it is deleted (Windows cannot delete a file that is still mapped).
        self.hub.invalidate(&model.id);
        // Older versions are no longer referenced.
        if let Ok(rd) = std::fs::read_dir(&parent) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy() != model.version {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        Ok(())
    }

    async fn fetch_file(
        &self,
        model: &CatalogModel,
        file: &CatalogFile,
        staging: &Path,
        ctl: &Control,
        base: u64,
        total: u64,
    ) -> AppResult<Outcome> {
        let id = model.id.as_str();
        let (cfg, client) = self.net();
        let target = staging.join(&file.path);
        if target.is_file() {
            // Finished before an earlier interruption.
            let (t, sha, size) = (target.clone(), file.sha256.clone(), file.size_bytes);
            let ok = tokio::task::spawn_blocking(move || {
                verify_file(&t, &sha, size, &std::sync::atomic::AtomicBool::new(false)).is_ok()
            })
            .await
            .unwrap_or(false);
            if ok {
                return Ok(Outcome::Completed);
            }
            let _ = std::fs::remove_file(&target);
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let part = staging.join(format!("{}.part", file.path));
        let mut last = AppError::Network("no download location is known".into());
        for url in self.urls_for(model, file) {
            if matches!(self.hub.state_of(id), ModelState::Verifying) {
                self.move_to(id, ModelState::Downloading);
            }
            let hub = Arc::clone(&self.hub);
            let model_id = id.to_string();
            let mut progress = move |done: u64, speed: u64| {
                let downloaded = base + done;
                let eta = total.saturating_sub(downloaded).checked_div(speed);
                hub.emit(
                    "model:progress",
                    json!({
                        "id": model_id, "downloadedBytes": downloaded, "totalBytes": total,
                        "speedBps": speed, "etaSeconds": eta,
                    }),
                );
            };
            let result = download_url(
                &client,
                &cfg,
                &url,
                &part,
                file.size_bytes,
                ctl,
                &mut progress,
            )
            .await;
            match result {
                Ok(Outcome::Completed) => {
                    self.move_to(id, ModelState::Verifying);
                    let (p, sha, size) = (part.clone(), file.sha256.clone(), file.size_bytes);
                    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let watcher = Arc::clone(&cancel);
                    let verdict =
                        tokio::task::spawn_blocking(move || verify_file(&p, &sha, size, &watcher));
                    // Mirror a cancel request onto the blocking verifier.
                    let verdict = loop {
                        if ctl.cancel.load(Ordering::Relaxed) {
                            cancel.store(true, Ordering::Relaxed);
                        }
                        if verdict.is_finished() {
                            break verdict.await;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    .map_err(|e| AppError::Internal(e.to_string()))?;
                    match verdict {
                        Ok(()) => {
                            std::fs::rename(&part, &target)?;
                            return Ok(Outcome::Completed);
                        }
                        Err(AppError::Cancelled) => return Ok(Outcome::Cancelled),
                        Err(e @ AppError::HashMismatch(_)) => {
                            let _ = std::fs::remove_file(&part);
                            last = e;
                        }
                        Err(e) => return Err(e),
                    }
                }
                Ok(other) => return Ok(other),
                Err(e) if e.code() == "DiskFull" => return Err(e),
                Err(e) => {
                    // Whatever this mirror left behind may not match the next one.
                    let _ = std::fs::remove_file(&part);
                    last = e;
                }
            }
        }
        Err(last)
    }

    /// Install a model from a file the user already has (for offline machines or restricted
    /// networks). A file that matches the catalog hash is installed as verified; any other file
    /// is refused with `Unverified` unless `allow_unverified` is set, and is then marked
    /// unverified. Only single-file models can be imported.
    pub async fn import_file(
        self: &Arc<Self>,
        id: &str,
        path: &str,
        allow_unverified: bool,
    ) -> AppResult<()> {
        let model = self
            .hub
            .catalog_model(id)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown model '{id}'")))?;
        if model.files.len() != 1 || is_zip(&model) {
            return Err(AppError::InvalidInput(format!(
                "{} is a multi-file package and cannot be imported from one file",
                model.name
            )));
        }
        match self.hub.state_of(id) {
            ModelState::NotInstalled
            | ModelState::UpdateAvailable
            | ModelState::Paused
            | ModelState::Failed { .. } => {}
            ModelState::Installed => {
                return Err(AppError::InvalidInput(format!(
                    "{} is already installed; remove it first",
                    model.name
                )))
            }
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "{} is busy right now",
                    model.name
                )))
            }
        }
        let file = model.files[0].clone();
        let src = PathBuf::from(path);
        let meta = std::fs::metadata(&src)
            .map_err(|_| AppError::InvalidInput("that file could not be found".into()))?;
        if !src.is_absolute() || !meta.is_file() {
            return Err(AppError::InvalidInput("choose a model file".into()));
        }
        let want_ext = Path::new(&file.path)
            .extension()
            .map(|e| e.to_ascii_lowercase());
        if src.extension().map(|e| e.to_ascii_lowercase()) != want_ext {
            return Err(AppError::UnsupportedFormat(format!(
                "{} expects a .{} file",
                model.name,
                want_ext
                    .map(|e| e.to_string_lossy().into_owned())
                    .unwrap_or_default()
            )));
        }
        if meta.len() == 0 || meta.len() > config::MAX_MODEL_BYTES {
            return Err(AppError::InvalidInput(
                "that file has an unusable size".into(),
            ));
        }
        let free = (self.net().0.free_space)(self.hub.models_dir());
        let need = meta.len() + (meta.len() / 20).max(32 * 1024 * 1024);
        if free < need {
            return Err(AppError::DiskFull(format!(
                "needs about {} MB free, {} MB available",
                need.div_ceil(1_000_000),
                free / 1_000_000
            )));
        }

        // Without the user's say-so, a file that does not match is refused before anything moves.
        let matches = {
            let (s, sha, size) = (src.clone(), file.sha256.clone(), file.size_bytes);
            tokio::task::spawn_blocking(move || {
                verify_file(&s, &sha, size, &std::sync::atomic::AtomicBool::new(false)).is_ok()
            })
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
        };
        if !matches && !allow_unverified {
            return Err(AppError::Unverified(format!(
                "this file does not match the published checksum for {}",
                model.name
            )));
        }

        let staging = staging_dir(self.hub.models_dir(), &model);
        let _ = std::fs::remove_dir_all(&staging);
        self.hub.transition(id, ModelState::Queued)?;
        self.hub.transition(id, ModelState::Downloading)?;
        let result = self.import_inner(&model, &src, &staging, matches).await;
        match result {
            Ok(()) => {
                self.move_to(id, ModelState::Installed);
                Ok(())
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                // Back to what the registry says; the caller reports the error.
                self.move_to(id, ModelState::NotInstalled);
                Err(e)
            }
        }
    }

    async fn import_inner(
        &self,
        model: &CatalogModel,
        src: &Path,
        staging: &Path,
        verified: bool,
    ) -> AppResult<()> {
        let id = model.id.as_str();
        let dest = staging.join(&model.files[0].path);
        let (s, d, m) = (src.to_path_buf(), dest.clone(), model.clone());
        let hash = tokio::task::spawn_blocking(move || -> AppResult<String> {
            use sha2::{Digest, Sha256};
            use std::io::{Read, Write};
            if let Some(parent) = d.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut input = std::fs::File::open(&s)?;
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&d)?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 1 << 20];
            let mut total = 0u64;
            loop {
                let n = input.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > config::MAX_MODEL_BYTES {
                    return Err(AppError::InvalidInput("that file is too large".into()));
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n]).map_err(|e| {
                    if matches!(e.raw_os_error(), Some(28) | Some(112)) {
                        AppError::DiskFull("the disk is full".into())
                    } else {
                        e.into()
                    }
                })?;
            }
            out.flush()?;
            let _ = &m;
            Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;

        self.hub.transition(id, ModelState::Verifying)?;
        // What was copied must be what was checked (the source could change in between).
        if verified && !hash.eq_ignore_ascii_case(&model.files[0].sha256) {
            return Err(AppError::HashMismatch(
                "the file changed while it was being imported".into(),
            ));
        }
        self.hub.transition(id, ModelState::Installing)?;
        let meta = json!({
            "id": model.id, "version": model.version, "sha256": hash,
            "files": [&model.files[0].path], "imported": true, "verified": verified,
            "installedAt": chrono::Utc::now().to_rfc3339(),
        });
        std::fs::write(staging.join("meta.json"), meta.to_string())?;
        self.commit(model, staging, ModelSource::Imported, verified, &hash)
    }

    /// Remove an installed model: let go of its sessions, forget it, delete its files. Bundled
    /// models cannot be removed. Afterwards it can be installed again.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let model = self
            .hub
            .catalog_model(id)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown model '{id}'")))?;
        match self.hub.state_of(id) {
            ModelState::Installed | ModelState::UpdateAvailable | ModelState::Failed { .. } => {}
            ModelState::NotInstalled => return Ok(()),
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "{} is busy; cancel it first",
                    model.name
                )))
            }
        }
        let record = self.hub.record(id);
        if record
            .as_ref()
            .is_some_and(|r| r.source == ModelSource::Bundled)
        {
            return Err(AppError::Permission(format!(
                "{} is part of Photom and cannot be removed",
                model.name
            )));
        }
        self.hub.transition(id, ModelState::Removing)?;
        // Unload before deleting: a mapped file cannot be deleted on Windows.
        self.hub.invalidate(id);
        let outcome = (|| -> AppResult<()> {
            self.hub.unregister(id)?;
            match std::fs::remove_dir_all(self.hub.models_dir().join(id)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            // A model imported before the hub existed lives as a single file elsewhere.
            if let Some(r) = record.filter(|r| std::path::Path::new(&r.path).is_absolute()) {
                match std::fs::remove_file(&r.path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            let _ = std::fs::remove_dir_all(staging_dir(self.hub.models_dir(), &model));
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                self.move_to(id, ModelState::NotInstalled);
                Ok(())
            }
            Err(e) => {
                self.force_failed(id, &e);
                Err(e)
            }
        }
    }

    /// Fetch the signed catalog. Never fails the caller: problems become a warning on the status
    /// and the catalog in use stays as it was.
    pub async fn refresh_catalog(&self) -> CatalogStatus {
        match self.fetch_catalog().await {
            Ok(()) => {}
            Err(e) => {
                tracing::warn!(code = e.code(), "catalog refresh failed");
                let why = match e {
                    AppError::Network(_) => {
                        "You are offline or the catalog server is unreachable.".to_string()
                    }
                    other => other.to_string(),
                };
                self.hub.set_catalog_warning(Some(why));
            }
        }
        self.hub.catalog_status()
    }

    async fn fetch_catalog(&self) -> AppResult<()> {
        let (cfg, client) = self.net();
        let url = reqwest::Url::parse(&cfg.catalog_url)
            .map_err(|_| AppError::Network("invalid catalog URL".into()))?;
        downloader::check_url(&cfg, &url)?;
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(AppError::Network(format!(
                "server answered {}",
                resp.status()
            )));
        }
        let mut body = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            body.extend_from_slice(&chunk.map_err(|e| AppError::Network(e.to_string()))?);
            if body.len() > MAX_CATALOG_BYTES {
                return Err(AppError::InvalidInput("catalog is too large".into()));
            }
        }
        let text = String::from_utf8(body)
            .map_err(|_| AppError::InvalidInput("catalog is not text".into()))?;
        let catalog =
            manifest::parse_verified_opts(&text, &self.hub.public_key(), self.hub.https_only())?;
        self.hub.set_catalog(catalog, &text)
    }
}

#[cfg(test)]
#[path = "installer_tests.rs"]
mod tests;
