//! Model Hub constants. Everything a deployment may need to change lives here.

/// Remote catalog. Placeholder until the real host exists (see docs/DECISIONS.md #50).
pub const CATALOG_URL: &str = "https://models.photom.example/catalog.v1.json";

/// Hosts the downloader may contact (re-checked after every redirect). The user can add one more
/// in Settings > Advanced (Phase H3).
pub const ALLOWED_HOSTS: &[&str] = &["models.photom.example"];

/// Catalog format this build understands.
pub const SCHEMA_VERSION: u32 = 1;

/// Ed25519 public key that signs catalogs. This is the DEVELOPMENT key (private half in
/// `.keys/catalog-dev.pem`, git-ignored). Replace before the first public release.
pub const CATALOG_PUBLIC_KEY: [u8; 32] = [
    0x27, 0xf7, 0xcf, 0x22, 0x14, 0xd0, 0x92, 0x8e, 0x01, 0xf0, 0xbd, 0xaa, 0xae, 0x00, 0x49, 0x09,
    0xf0, 0x95, 0x34, 0x16, 0x1f, 0x66, 0x3f, 0x94, 0x81, 0x5b, 0x59, 0x56, 0x87, 0x16, 0x26, 0xe2,
];

/// Catalog shipped inside the app; used when the remote one is unreachable or fails verification.
pub const BUNDLED_CATALOG: &str = include_str!("catalog.bundled.json");

/// Sanity limits applied when validating any catalog.
pub const MAX_MODELS: usize = 256;
pub const MAX_FILES_PER_MODEL: usize = 16;
pub const MAX_MODEL_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// A hash made only of zeros marks a catalog entry whose real file has not been published yet.
pub const PLACEHOLDER_SHA256: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// A bare host name for the "extra download host" setting: letters, digits, dots and dashes only
/// (no scheme, port, path or wildcard). Returns it lower-cased.
pub fn clean_host(raw: &str) -> Option<String> {
    let h = raw.trim().to_ascii_lowercase();
    let ok = !h.is_empty()
        && h.len() <= 253
        && h.contains(|c: char| c.is_ascii_alphanumeric())
        && !h.starts_with(['.', '-'])
        && !h.ends_with(['.', '-'])
        && h.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
    ok.then_some(h)
}

/// An https URL with a host, for the "catalog URL" setting.
pub fn clean_catalog_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.len() > 2048 {
        return None;
    }
    let url = reqwest::Url::parse(t).ok()?;
    (url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty())
        .then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_must_be_plain_names() {
        assert_eq!(
            clean_host(" Models.Example.COM "),
            Some("models.example.com".into())
        );
        for bad in [
            "",
            "https://a.com",
            "a.com/x",
            "a.com:8080",
            "*.a.com",
            "-a.com",
            "a b",
            "..",
            "a.com.",
        ] {
            assert_eq!(clean_host(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn catalog_urls_must_be_https_without_credentials() {
        assert!(clean_catalog_url("https://mirror.example/catalog.v1.json").is_some());
        for bad in [
            "http://a.example/c.json",
            "ftp://a.example",
            "not a url",
            "https://u:p@a.example/",
            "",
        ] {
            assert_eq!(clean_catalog_url(bad), None, "{bad:?}");
        }
    }
}
