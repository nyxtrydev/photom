//! Catalog parsing, validation and Ed25519 signature verification.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::config;
use crate::models::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u32,
    pub generated_at: String,
    pub models: Vec<CatalogModel>,
    #[serde(default)]
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub feature: String,
    pub version: String,
    pub description: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub format: String,
    pub files: Vec<CatalogFile>,
    pub urls: Vec<String>,
    pub license: License,
    pub requirements: Requirements,
    pub runtime: Runtime,
    pub recommended: bool,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct License {
    pub name: String,
    pub url: String,
    pub commercial_use: bool,
    pub attribution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Requirements {
    pub min_ram_mb: u32,
    pub gpu_optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub input_size: [u32; 2],
    pub normalization: String,
    #[serde(default)]
    pub notes: String,
}

impl CatalogModel {
    /// False for entries whose real file is not published yet (all-zero hash) or that have no
    /// download location (bundled models).
    pub fn installable(&self) -> bool {
        !self.urls.is_empty()
            && self.sha256 != config::PLACEHOLDER_SHA256
            && self
                .files
                .iter()
                .all(|f| f.sha256 != config::PLACEHOLDER_SHA256)
    }
}

/// Deterministic JSON: object keys sorted at every level, no whitespace. Must match
/// `scripts/lib/catalog.mjs`.
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Parse a catalog, verify its signature with `key`, then validate its contents.
pub fn parse_verified(json: &str, key: &[u8; 32]) -> AppResult<Catalog> {
    parse_verified_opts(json, key, true)
}

/// `https_only = false` exists for tests that serve catalogs from a local mock server.
pub fn parse_verified_opts(json: &str, key: &[u8; 32], https_only: bool) -> AppResult<Catalog> {
    let raw: Value = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidInput(format!("catalog is not valid JSON: {e}")))?;
    let models = raw
        .get("models")
        .ok_or_else(|| AppError::InvalidInput("catalog has no models".into()))?;
    let signature = raw
        .get("signature")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::InvalidInput("catalog is not signed".into()))?;
    verify_signature(&canonical_json(models), signature, key)?;
    let catalog: Catalog = serde_json::from_value(raw)
        .map_err(|e| AppError::InvalidInput(format!("catalog has an unexpected shape: {e}")))?;
    validate(&catalog, https_only)?;
    Ok(catalog)
}

fn verify_signature(message: &str, signature_b64: &str, key: &[u8; 32]) -> AppResult<()> {
    let bad = |why: &str| AppError::InvalidInput(format!("catalog signature rejected: {why}"));
    let bytes = STANDARD
        .decode(signature_b64)
        .map_err(|_| bad("not base64"))?;
    let sig = Signature::from_slice(&bytes).map_err(|_| bad("wrong length"))?;
    let vk = VerifyingKey::from_bytes(key).map_err(|_| bad("bad public key"))?;
    vk.verify_strict(message.as_bytes(), &sig)
        .map_err(|_| bad("does not match the content"))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A relative path made of plain components only (no `..`, no absolute paths, no separators
/// tricks). Archives and multi-file sets rely on this.
pub fn is_safe_relative_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && !p.starts_with('/')
        && !p.starts_with('\\')
        && !p.contains(':')
        && !p.contains('\0')
        && p.split(['/', '\\'])
            .all(|c| !c.is_empty() && c != "." && c != "..")
}

pub fn validate(c: &Catalog, https_only: bool) -> AppResult<()> {
    let bad = |m: String| Err(AppError::InvalidInput(format!("catalog: {m}")));
    if c.schema_version != config::SCHEMA_VERSION {
        return bad(format!("unsupported schemaVersion {}", c.schema_version));
    }
    if c.models.len() > config::MAX_MODELS {
        return bad("too many models".into());
    }
    let mut seen = std::collections::HashSet::new();
    for m in &c.models {
        if !is_slug(&m.id) || !seen.insert(m.id.as_str()) {
            return bad(format!("invalid or duplicate id '{}'", m.id));
        }
        if semver::Version::parse(&m.version).is_err() {
            return bad(format!("{}: version '{}' is not semver", m.id, m.version));
        }
        if !is_hex64(&m.sha256) {
            return bad(format!("{}: sha256 is not 64 hex characters", m.id));
        }
        if m.size_bytes > config::MAX_MODEL_BYTES {
            return bad(format!("{}: larger than the size cap", m.id));
        }
        if m.files.is_empty() || m.files.len() > config::MAX_FILES_PER_MODEL {
            return bad(format!(
                "{}: needs 1..{} files",
                m.id,
                config::MAX_FILES_PER_MODEL
            ));
        }
        for f in &m.files {
            if !is_safe_relative_path(&f.path) || !is_hex64(&f.sha256) {
                return bad(format!("{}: unsafe file entry '{}'", m.id, f.path));
            }
        }
        if m.urls
            .iter()
            .any(|u| !(u.starts_with("https://") || !https_only && u.starts_with("http://")))
        {
            return bad(format!("{}: only https URLs are allowed", m.id));
        }
    }
    for m in &c.models {
        for d in &m.depends_on {
            if !seen.contains(d.as_str()) {
                return bad(format!("{}: depends on unknown model '{d}'", m.id));
            }
        }
    }
    Ok(())
}

/// True when `candidate` is a newer semver than `installed`. Unparseable versions never update.
pub fn is_newer(candidate: &str, installed: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(installed),
    ) {
        (Ok(c), Ok(i)) => c > i,
        _ => false,
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
