//! Streaming HTTP download with Range resume, retries and a host allowlist.
//! Only the backend opens connections; the web layer has no network permission.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::{redirect, Client, StatusCode, Url};
use tokio::io::AsyncWriteExt;

use super::config;
use crate::models::error::{AppError, AppResult};

/// Network behaviour. `Default` is the production setting; tests shrink the delays.
#[derive(Clone)]
pub struct NetConfig {
    pub allowed_hosts: Vec<String>,
    pub https_only: bool,
    /// Attempts per URL for transient errors.
    pub attempts: u32,
    pub backoff_base: Duration,
    pub progress_interval: Duration,
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    pub catalog_url: String,
    /// Free bytes on the volume holding `path` (injectable so disk-full is testable).
    pub free_space: Arc<dyn Fn(&Path) -> u64 + Send + Sync>,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            allowed_hosts: config::ALLOWED_HOSTS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            https_only: true,
            attempts: 3,
            backoff_base: Duration::from_millis(800),
            progress_interval: Duration::from_millis(250),
            connect_timeout: Duration::from_secs(15),
            read_timeout: Duration::from_secs(30),
            catalog_url: config::CATALOG_URL.to_string(),
            free_space: Arc::new(|p| fs4::available_space(p).unwrap_or(u64::MAX)),
        }
    }
}

/// Pause/cancel switches shared between the UI commands and a running download.
#[derive(Debug, Default)]
pub struct Control {
    pub pause: AtomicBool,
    pub cancel: AtomicBool,
}

impl Control {
    fn stop_requested(&self) -> bool {
        self.pause.load(Ordering::Relaxed) || self.cancel.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The whole file is on disk (still to be verified).
    Completed,
    /// Stopped on request; the `.part` file is kept for resuming.
    Paused,
    /// Stopped on request; the caller discards the `.part` file.
    Cancelled,
}

/// Allowed when the scheme is acceptable and the host is on the list (case-insensitive).
pub fn check_url(cfg: &NetConfig, url: &Url) -> AppResult<()> {
    if cfg.https_only && url.scheme() != "https" {
        return Err(AppError::Network("only https downloads are allowed".into()));
    }
    if !matches!(url.scheme(), "https" | "http") {
        return Err(AppError::Network("unsupported URL scheme".into()));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if !cfg
        .allowed_hosts
        .iter()
        .any(|h| h.eq_ignore_ascii_case(&host))
    {
        return Err(AppError::Network(format!("host '{host}' is not allowed")));
    }
    Ok(())
}

/// HTTP client: rustls, system proxy, timeouts, and a redirect policy that re-checks the host
/// of every hop.
pub fn build_client(cfg: &NetConfig) -> AppResult<Client> {
    let hop = cfg.clone();
    Client::builder()
        .user_agent(concat!("Photom/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(cfg.connect_timeout)
        .read_timeout(cfg.read_timeout)
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            match check_url(&hop, attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(e) => attempt.error(e.to_string()),
            }
        }))
        .build()
        .map_err(|e| AppError::Network(e.to_string()))
}

enum Fail {
    /// Worth retrying (connection trouble, 5xx, truncated body).
    Transient(String),
    /// Retrying the same URL cannot help (404, size overflow, disallowed redirect).
    Permanent(String),
    Fatal(AppError),
}

fn io_fail(e: std::io::Error) -> Fail {
    // ENOSPC on Unix, ERROR_DISK_FULL on Windows.
    let full = matches!(e.raw_os_error(), Some(28) | Some(112));
    if full {
        Fail::Fatal(AppError::DiskFull("the disk is full".into()))
    } else {
        Fail::Fatal(e.into())
    }
}

fn classify(e: &reqwest::Error) -> Fail {
    if e.is_redirect() {
        return Fail::Permanent(e.to_string());
    }
    Fail::Transient(e.to_string())
}

/// Download `url` into `part`, resuming from whatever is already there. Retries transient errors
/// with exponential backoff; a permanent failure is returned for the caller to try a mirror.
/// `on_progress(downloaded, bytes_per_second)` is called at most once per `progress_interval`.
pub async fn download_url(
    client: &Client,
    cfg: &NetConfig,
    url: &str,
    part: &Path,
    expected_size: u64,
    ctl: &Control,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> AppResult<Outcome> {
    let parsed = Url::parse(url).map_err(|_| AppError::Network("invalid download URL".into()))?;
    check_url(cfg, &parsed)?;
    if let Some(dir) = part.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut last = String::from("no attempt made");
    for attempt in 0..cfg.attempts.max(1) {
        if attempt > 0 {
            let delay = cfg.backoff_base * 2u32.pow(attempt - 1);
            let deadline = Instant::now() + delay;
            while Instant::now() < deadline {
                if ctl.stop_requested() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20).min(delay)).await;
            }
        }
        match attempt_once(
            client,
            cfg,
            parsed.clone(),
            part,
            expected_size,
            ctl,
            on_progress,
        )
        .await
        {
            Ok(o) => return Ok(o),
            Err(Fail::Transient(m)) => {
                tracing::warn!(attempt, "download attempt failed: {m}");
                last = m;
            }
            Err(Fail::Permanent(m)) => return Err(AppError::Network(m)),
            Err(Fail::Fatal(e)) => return Err(e),
        }
    }
    Err(AppError::Network(last))
}

async fn attempt_once(
    client: &Client,
    cfg: &NetConfig,
    url: Url,
    part: &Path,
    expected: u64,
    ctl: &Control,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<Outcome, Fail> {
    let mut have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if have > expected {
        let _ = std::fs::remove_file(part);
        have = 0;
    }
    on_progress(have, 0);
    if ctl.cancel.load(Ordering::Relaxed) {
        return Ok(Outcome::Cancelled);
    }
    if ctl.pause.load(Ordering::Relaxed) {
        return Ok(Outcome::Paused);
    }
    if have == expected && expected > 0 {
        return Ok(Outcome::Completed);
    }

    let mut req = client.get(url);
    if have > 0 {
        req = req.header(RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(|e| classify(&e))?;
    let status = resp.status();
    let append = match status {
        StatusCode::OK => false,
        StatusCode::PARTIAL_CONTENT => {
            let start = resp
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("bytes "))
                .and_then(|v| v.split('-').next())
                .and_then(|v| v.parse::<u64>().ok());
            if start != Some(have) {
                let _ = std::fs::remove_file(part);
                return Err(Fail::Transient("server resumed at the wrong offset".into()));
            }
            true
        }
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let _ = std::fs::remove_file(part);
            return Err(Fail::Transient("stale partial download discarded".into()));
        }
        s if s == StatusCode::TOO_MANY_REQUESTS || s.is_server_error() => {
            return Err(Fail::Transient(format!("server answered {s}")));
        }
        s => return Err(Fail::Permanent(format!("server answered {s}"))),
    };
    let base = if append { have } else { 0 };
    let announced = resp
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if let Some(len) = announced {
        if base + len > expected {
            let _ = std::fs::remove_file(part);
            return Err(Fail::Permanent(format!(
                "server announced {} bytes, more than the {expected} expected",
                base + len
            )));
        }
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(part)
        .await
        .map_err(io_fail)?;
    let mut total = base;
    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut last_bytes = total;
    let mut speed = 0u64;
    while let Some(chunk) = stream.next().await {
        if ctl.cancel.load(Ordering::Relaxed) {
            let _ = file.flush().await;
            return Ok(Outcome::Cancelled);
        }
        if ctl.pause.load(Ordering::Relaxed) {
            file.flush().await.map_err(io_fail)?;
            return Ok(Outcome::Paused);
        }
        let chunk = chunk.map_err(|e| classify(&e))?;
        total += chunk.len() as u64;
        if total > expected {
            drop(file);
            let _ = std::fs::remove_file(part);
            return Err(Fail::Permanent(
                "server sent more data than expected".into(),
            ));
        }
        file.write_all(&chunk).await.map_err(io_fail)?;
        let dt = last_emit.elapsed();
        if dt >= cfg.progress_interval {
            let instant = ((total - last_bytes) as f64 / dt.as_secs_f64().max(0.001)) as u64;
            speed = if speed == 0 {
                instant
            } else {
                (speed + instant) / 2
            };
            on_progress(total, speed);
            last_emit = Instant::now();
            last_bytes = total;
        }
    }
    file.flush().await.map_err(io_fail)?;
    drop(file);
    on_progress(total, speed);
    if total != expected {
        return Err(Fail::Transient(format!(
            "connection ended after {total} of {expected} bytes"
        )));
    }
    Ok(Outcome::Completed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_disk_is_recognised_on_unix_and_windows() {
        for code in [28, 112] {
            let f = io_fail(std::io::Error::from_raw_os_error(code));
            assert!(
                matches!(f, Fail::Fatal(AppError::DiskFull(_))),
                "os error {code}"
            );
        }
        let other = io_fail(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(matches!(other, Fail::Fatal(AppError::Permission(_))));
    }

    #[test]
    fn host_checks_ignore_case_and_reject_lookalikes() {
        let cfg = NetConfig::default();
        let ok = |u: &str| check_url(&cfg, &Url::parse(u).unwrap()).is_ok();
        assert!(ok("https://models.photom.example/a"));
        assert!(ok("https://MODELS.PHOTOM.EXAMPLE/a"));
        assert!(!ok("https://models.photom.example.evil.example/a"));
        assert!(!ok("https://evilmodels.photom.example/a"));
        assert!(!ok("https://models.photom.example@evil.example/a"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("ftp://models.photom.example/a"));
    }
}
