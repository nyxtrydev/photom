//! The update check against a local "release server", using a mock Tauri app that carries the
//! same updater configuration shape as the real one.

use std::io::{Read, Write};
use std::net::TcpListener;

use serde_json::json;

use super::*;

const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENFMjQ0NzE2QjdDNjM2OEEKUldTS05zYTNGa2Nremt5b0JVNEVkUHhDYUVwL1VhTU1jTm9hWWIyMUhpdEFaZTJGOFFOVlZlK0YK";

/// Serve `body` as JSON to every request. Returns the base URL.
fn serve(status: &'static str, body: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { break };
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes());
        }
    });
    format!("http://127.0.0.1:{port}/latest.json")
}

/// A static update manifest announcing `version` for every platform we ship.
fn manifest(version: &str, port_url: &str) -> String {
    let entry = json!({ "signature": "dGVzdA==", "url": format!("{port_url}.bin") });
    let mut platforms = serde_json::Map::new();
    for os in ["windows", "darwin", "linux"] {
        for arch in ["x86_64", "aarch64"] {
            platforms.insert(format!("{os}-{arch}"), entry.clone());
        }
    }
    json!({ "version": version, "notes": "Faster exports and a new icon.", "pub_date": "2026-10-05T10:00:00Z", "platforms": platforms }).to_string()
}

fn app_with_endpoint(endpoint: &str) -> tauri::App<tauri::test::MockRuntime> {
    let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
    ctx.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey": PUBKEY,
            "endpoints": [endpoint],
            "dangerousInsecureTransportProtocol": true,
            "requireSignedVersion": true
        }),
    );
    tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(ctx)
        .unwrap()
}

fn run<T>(f: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(f)
}

#[test]
fn a_newer_release_is_reported_with_its_notes() {
    // The mock app's version comes from the test crate (0.1.0).
    let url = serve("200 OK", manifest("9.9.9", "http://127.0.0.1:1/x"));
    let app = app_with_endpoint(&url);
    let (info, update) = run(check(app.handle())).unwrap();
    assert!(info.available);
    assert_eq!(info.version.as_deref(), Some("9.9.9"));
    assert_eq!(
        info.notes.as_deref(),
        Some("Faster exports and a new icon.")
    );
    assert_eq!(
        info.current_version,
        env!("CARGO_PKG_VERSION").replace(
            env!("CARGO_PKG_VERSION"),
            &app.package_info().version.to_string()
        )
    );
    assert!(
        update.is_some(),
        "the downloadable update is kept for install"
    );
}

#[test]
fn being_up_to_date_is_not_an_error() {
    let current = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
        .package_info()
        .version
        .to_string();
    let url = serve("200 OK", manifest(&current, "http://127.0.0.1:1/x"));
    let app = app_with_endpoint(&url);
    let (info, update) = run(check(app.handle())).unwrap();
    assert!(!info.available);
    assert!(update.is_none());
}

#[test]
fn an_older_release_is_never_offered_as_an_update() {
    let url = serve("200 OK", manifest("0.0.1", "http://127.0.0.1:1/x"));
    let app = app_with_endpoint(&url);
    let (info, _) = run(check(app.handle())).unwrap();
    assert!(!info.available, "downgrades must not be offered");
}

#[test]
fn an_unreachable_server_gives_a_plain_language_error() {
    let app = app_with_endpoint("http://127.0.0.1:1/latest.json");
    let err = run(check(app.handle())).err().expect("the check must fail");
    assert_eq!(err.code(), "Io");
    assert!(
        err.to_string()
            .contains("Could not reach the update server"),
        "{err}"
    );
}

#[test]
fn a_server_error_or_garbage_is_reported_not_a_crash() {
    for (status, body) in [
        ("500 Internal Server Error", "oops".to_string()),
        ("200 OK", "not json".to_string()),
    ] {
        let app = app_with_endpoint(&serve(status, body));
        assert!(run(check(app.handle())).is_err(), "{status}");
    }
}
