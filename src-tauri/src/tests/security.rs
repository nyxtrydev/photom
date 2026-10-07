//! Guards for the privacy promise: the web layer cannot reach the network, and only the backend
//! downloads models.

use std::path::Path;

fn read(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap_or_else(|e| panic!("{rel}: {e}"))
}

#[test]
fn the_csp_allows_no_outside_connections() {
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let csp = conf["app"]["security"]["csp"]
        .as_str()
        .expect("a CSP is set");
    let connect = csp
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("connect-src"))
        .expect("connect-src is set");
    for source in connect.split_whitespace().skip(1) {
        assert!(
            matches!(source, "'self'" | "ipc:" | "http://ipc.localhost"),
            "connect-src may not allow {source}"
        );
    }
    assert!(!csp.contains("unsafe-eval"));
    assert!(csp.contains("default-src 'self'"));
}

#[test]
fn the_window_has_no_network_or_shell_permissions() {
    let caps = read("capabilities/default.json");
    for forbidden in ["http:", "shell:", "opener:", "fs:allow", "updater:"] {
        assert!(
            !caps.contains(forbidden),
            "capability must not include {forbidden}"
        );
    }
}

#[test]
fn no_http_or_shell_plugin_is_linked() {
    let manifest = read("Cargo.toml");
    for forbidden in [
        "tauri-plugin-http",
        "tauri-plugin-shell",
        "tauri-plugin-opener",
    ] {
        assert!(
            !manifest.contains(forbidden),
            "{forbidden} would give the web layer a way out"
        );
    }
}

#[test]
fn model_downloads_are_not_exposed_to_the_asset_protocol() {
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let scope = conf["app"]["security"]["assetProtocol"]["scope"].to_string();
    assert!(
        !scope.contains("models"),
        "model files must not be readable by the web layer: {scope}"
    );
}
