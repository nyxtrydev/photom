# Releasing Photom

Photom is offline-first. Nothing in the app contacts the network on its own; the only network feature is the **opt-in** "Check for updates" button in Settings > About.

## One-time setup

### 1. Update signing key (required)

Updates are verified with a minisign signature, so the key must be yours.

```bash
npx tauri signer generate -w ~/.tauri/photom-updater.key
```

- Put the **public** key in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- Put the **private** key in the repository secret `TAURI_SIGNING_PRIVATE_KEY` (and its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- Set `plugins.updater.endpoints` to your release feed, e.g. `https://github.com/<owner>/photom/releases/latest/download/latest.json`.

> The `pubkey` committed in the repository belongs to a development key whose private half is **not** distributed. Replace it before the first public release, otherwise nobody (including you) can ship a valid update. If you lose the private key, installed apps can never be updated again.

`requireSignedVersion` is on: an update is rejected unless its signature carries the version the feed announces, and downgrades are never offered.

### 2. Code signing

| Platform    | What you need                                                                                                             | Secrets / config                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows** | An Authenticode certificate (OV/EV, or Azure Trusted Signing). Unsigned installers work but trigger SmartScreen warnings. | Add `bundle.windows.certificateThumbprint` (and `signCommand` for Azure/cloud HSM) through a `--config` override in the release workflow; store the `.pfx` as a secret and import it in a step before `tauri-action`. |
| **macOS**   | An Apple Developer ID Application certificate and notarisation credentials.                                               | Secrets `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`. The workflow already forwards them.                  |
| **Linux**   | Nothing required. AppImage/deb are unsigned; publish checksums if you like.                                               | -                                                                                                                                                                                                                     |

Without these secrets the workflow still builds and publishes; the artifacts are simply unsigned.

## Cutting a release

```bash
npm run version:bump -- minor            # or patch / major / 1.2.3 (package.json, Cargo.toml, tauri.conf.json)
npm run changelog -- 0.2.0               # CHANGELOG.md + RELEASE_NOTES.md from conventional commits
git commit -am "chore(release): 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

`node scripts/changelog.mjs --suggest` prints the bump the commits imply (breaking > feat > fix).

Pushing the tag runs `.github/workflows/release.yml`, which:

1. fetches the model and builds the compact fp16 file (`scripts/make-fast-model.py`), and removes the float32 file so only the fp16 model ships,
2. regenerates `THIRD_PARTY_LICENSES.md` (`npm run licenses`),
3. builds installers: Windows NSIS + MSI (plus an _offline_ variant), macOS arm64 and x64 DMG, Linux AppImage + deb,
4. signs the update bundles and uploads `latest.json` so the in-app updater can find the release,
5. downloads the published installers and smoke-tests them (`photom --smoke-test`) on each OS,
6. leaves the release as a **draft** for you to review and publish.

## Windows: WebView2 and fully offline installs

Photom uses the system WebView2 runtime (preinstalled on Windows 11 and current Windows 10). The default installer downloads it only if it is missing (needs internet once). For a machine that is **never** online, ship the `windows-offline` installer, which embeds the WebView2 runtime (about 130 MB larger).

## File association

Installers register `.photom`. Double-clicking a project starts Photom and opens it; double-clicking another while Photom is running opens it in the running window (single-instance). macOS delivers this as an "Open" event, Windows/Linux as a command-line argument; both end up in the same code path (`src-tauri/src/launch.rs`).

## Intel macOS

There are no prebuilt ONNX Runtime binaries for Intel Macs, so that build loads the official runtime library at run time and bundles it in `Contents/Frameworks` (`tauri.macos-x64.conf.json`). Apple Silicon, Windows and Linux link ONNX Runtime directly.

## Local test builds

```bash
npm run model:fetch                               # model (and fp16 build if Python + onnx are installed)
npx tauri build --bundles app --config src-tauri/tauri.release.conf.json   # macOS .app
src-tauri/target/release/bundle/macos/Photom.app/Contents/MacOS/photom --smoke-test
```

`--smoke-test [--smoke-out file]` imports a generated image, removes its background with the bundled model, exports a cropped PNG, verifies the alpha channel and exits 0/1. It is the same check CI runs.
