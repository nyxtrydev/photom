use super::*;
use ed25519_dalek::{Signer, SigningKey};

fn sample_models() -> Value {
    let c: Catalog = serde_json::from_str(config::BUNDLED_CATALOG).unwrap();
    serde_json::to_value(c.models).unwrap()
}

/// Build a signed catalog with a throwaway key.
fn signed(models: Value, sk: &SigningKey) -> String {
    let sig = sk.sign(canonical_json(&models).as_bytes());
    serde_json::json!({
        "schemaVersion": 1,
        "generatedAt": "2026-01-01T00:00:00Z",
        "models": models,
        "signature": STANDARD.encode(sig.to_bytes()),
    })
    .to_string()
}

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn public(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

#[test]
fn canonical_form_matches_the_node_signer() {
    // Same vector as scripts/lib/catalog.test.mjs.
    let v: Value =
        serde_json::from_str(r#"{"b":[1,{"z":true,"a":null}],"a":"x\"y","c":{"k":2}}"#).unwrap();
    assert_eq!(
        canonical_json(&v),
        r#"{"a":"x\"y","b":[1,{"a":null,"z":true}],"c":{"k":2}}"#
    );
}

#[test]
fn the_bundled_catalog_verifies_with_the_embedded_key() {
    let c = parse_verified(config::BUNDLED_CATALOG, &config::CATALOG_PUBLIC_KEY).unwrap();
    assert_eq!(c.models.len(), 7);
    assert!(c.models.iter().any(|m| m.id == "bgremoval-fast"));
}

#[test]
fn a_tampered_manifest_is_rejected() {
    let tampered = config::BUNDLED_CATALOG.replace("\"sizeBytes\": 90634529", "\"sizeBytes\": 1");
    assert_ne!(tampered, config::BUNDLED_CATALOG);
    let err = parse_verified(&tampered, &config::CATALOG_PUBLIC_KEY).unwrap_err();
    assert!(err.to_string().contains("signature rejected"), "{err}");
}

#[test]
fn a_catalog_signed_by_another_key_is_rejected() {
    let other = SigningKey::from_bytes(&[9u8; 32]);
    let json = signed(sample_models(), &other);
    assert!(parse_verified(&json, &public(&key())).is_err());
    assert!(parse_verified(&json, &public(&other)).is_ok());
}

#[test]
fn a_missing_signature_is_rejected() {
    let mut v: Value = serde_json::from_str(config::BUNDLED_CATALOG).unwrap();
    v["signature"] = Value::String(String::new());
    let err = parse_verified(&v.to_string(), &config::CATALOG_PUBLIC_KEY).unwrap_err();
    assert!(err.to_string().contains("not signed"));
    v.as_object_mut().unwrap().remove("signature");
    assert!(parse_verified(&v.to_string(), &config::CATALOG_PUBLIC_KEY).is_err());
}

#[test]
fn key_order_and_whitespace_do_not_affect_the_signature() {
    let sk = key();
    let json = signed(sample_models(), &sk);
    let pretty =
        serde_json::to_string_pretty(&serde_json::from_str::<Value>(&json).unwrap()).unwrap();
    assert!(parse_verified(&pretty, &public(&sk)).is_ok());
}

fn invalid(mutate: impl FnOnce(&mut Vec<Value>)) -> AppResult<Catalog> {
    let sk = key();
    let mut models = sample_models().as_array().unwrap().clone();
    mutate(&mut models);
    parse_verified(&signed(Value::Array(models), &sk), &public(&sk))
}

#[test]
fn validation_rejects_unsafe_content() {
    assert!(invalid(|_| {}).is_ok());
    assert!(invalid(|m| m[1]["files"][0]["path"] = "../evil.onnx".into()).is_err());
    assert!(invalid(|m| m[1]["files"][0]["path"] = "/etc/passwd".into()).is_err());
    assert!(invalid(|m| m[1]["urls"][0] = "http://insecure.example/m.onnx".into()).is_err());
    assert!(invalid(|m| m[1]["sha256"] = "xyz".into()).is_err());
    assert!(invalid(|m| m[1]["version"] = "latest".into()).is_err());
    assert!(invalid(|m| m[1]["id"] = "Bad Id".into()).is_err());
    assert!(invalid(|m| m[1]["id"] = m[0]["id"].clone()).is_err());
    assert!(invalid(|m| m[1]["dependsOn"] = serde_json::json!(["nope"])).is_err());
    assert!(invalid(|m| m[1]["sizeBytes"] = (config::MAX_MODEL_BYTES + 1).into()).is_err());
}

#[test]
fn safe_relative_paths() {
    for ok in ["model.onnx", "a/b/c.bin", "weights\\x.bin"] {
        assert!(is_safe_relative_path(ok), "{ok}");
    }
    for bad in [
        "", "..", "a/../b", "/abs", "\\abs", "C:\\x", "a//b", "./a", "a\0b",
    ] {
        assert!(!is_safe_relative_path(bad), "{bad:?}");
    }
}

#[test]
fn version_comparison_is_semver() {
    assert!(is_newer("1.10.0", "1.9.0"));
    assert!(is_newer("2.0.0", "1.9.9"));
    assert!(!is_newer("1.0.0", "1.0.0"));
    assert!(!is_newer("0.9.0", "1.0.0"));
    assert!(!is_newer("garbage", "1.0.0"));
}

#[test]
fn placeholder_entries_are_not_installable() {
    let c = parse_verified(config::BUNDLED_CATALOG, &config::CATALOG_PUBLIC_KEY).unwrap();
    let get = |id: &str| c.models.iter().find(|m| m.id == id).unwrap();
    assert!(!get("upscale-x2").installable());
    assert!(
        !get("bgremoval-fast").installable(),
        "bundled: nothing to download"
    );
}

#[test]
fn every_catalog_model_is_permissively_licensed_for_commercial_use() {
    // The licence rule (docs/DECISIONS.md #58): nothing non-commercial may be listed.
    let c = parse_verified(config::BUNDLED_CATALOG, &config::CATALOG_PUBLIC_KEY).unwrap();
    let permissive = ["Apache-2.0", "MIT", "BSD-3-Clause", "BSD-2-Clause"];
    for m in &c.models {
        assert!(
            m.license.commercial_use,
            "{}: commercial use must be allowed",
            m.id
        );
        assert!(
            permissive.contains(&m.license.name.as_str()),
            "{}: {}",
            m.id,
            m.license.name
        );
        assert!(m.license.url.starts_with("https://"), "{}", m.id);
        assert!(
            !m.license.attribution.is_empty(),
            "{}: attribution is required",
            m.id
        );
    }
}

#[test]
fn bundled_catalog_downloads_only_come_from_allowed_hosts() {
    let c = parse_verified(config::BUNDLED_CATALOG, &config::CATALOG_PUBLIC_KEY).unwrap();
    for m in &c.models {
        for u in &m.urls {
            let host = u.trim_start_matches("https://").split('/').next().unwrap();
            assert!(config::ALLOWED_HOSTS.contains(&host), "{}: {host}", m.id);
        }
    }
}

#[test]
fn the_catalog_covers_every_feature_the_app_plans_to_gate() {
    let c = parse_verified(config::BUNDLED_CATALOG, &config::CATALOG_PUBLIC_KEY).unwrap();
    let features: std::collections::BTreeSet<_> =
        c.models.iter().map(|m| m.feature.as_str()).collect();
    assert_eq!(
        features.into_iter().collect::<Vec<_>>(),
        [
            "background-removal",
            "enhancement",
            "text-removal",
            "upscale"
        ]
    );
}
