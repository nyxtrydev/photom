# Model Hub

How extra AI models are catalogued, published, installed and kept private. Photom ships one background-removal model inside the installer; everything else is an optional download that works fully offline once installed.

## What the user sees

- **Install banner** inside any feature panel whose model is missing: _Install now_, progress with pause and cancel, plain-language failures.
- **Settings > Models**: every model with status, size and licence; install, pause, resume, cancel, update, remove, import a file you already have, check for updates, open the folder, and an **Advanced** section for restricted networks.
- A one-time first-run offer (only when there is something to download), a status-bar chip for running downloads, and a "... is ready" toast.

## Privacy and security rules

1. Only the Rust backend opens connections, and only after a user action (install, resume, check for updates). Starting the app, listing models and running features never touch the network (tested).
2. HTTPS only. Hosts must be on the allowlist (`model_hub/config.rs` plus the optional Advanced extra host), checked again on every redirect.
3. The catalog is signed (Ed25519). An unsigned, tampered, wrongly signed, invalid or older catalog is ignored and the previous one stays in use.
4. Every file is checked against the catalog size and SHA-256 before it becomes visible; a partial or corrupt download is never installed. A larger-than-announced response is cut off.
5. Zip packages are extracted with path checks (no `..`, absolute paths or symlinks) and size limits. Models are data; nothing downloaded is ever executed.
6. A file the user imports that does not match the catalog is installed only after explicit consent and stays marked **Unverified**.
7. The web layer has no network, shell or file-system permissions and the CSP allows no outside connections. `src-tauri/src/tests/security.rs` fails the build if that changes.
8. Logs contain model ids, states and error codes only.

## Where things live

```
<app data>/models/
  registry.json              installed models (atomic writes)
  catalog.cache.json         last verified catalog from the server
  .downloads/<id>-<ver>/     partial downloads (*.part), resumable
  <id>/<version>/            installed files + meta.json
```

## Publishing a model (checklist)

1. **Licence first.** It must allow redistribution _and_ commercial use (Apache-2.0, MIT, BSD). No non-commercial weights. Record the check in `docs/DECISIONS.md` and fill `license.url` and `license.attribution`. A test fails if a non-permissive licence is added.
2. Convert to ONNX, test it, and note `runtime.inputSize` and `normalization`.
3. Upload the file to the model host (a folder per `id/version/`).
4. Fill the catalog entry from the real file:
   ```
   node scripts/catalog-fill.mjs src-tauri/src/model_hub/catalog.bundled.json upscale-x2 ./RealESRGAN_x2.onnx \
     --url https://models.photom.example/upscale-x2/1.0.0/model.onnx
   ```
   This sets `sha256` and `sizeBytes` (model and file) and puts the URL first. Entries whose hash is all zeros are shown as "not available yet" and cannot be installed.
5. Sign: `node scripts/sign-catalog.mjs <catalog.json>` (uses `.keys/catalog-dev.pem`; production uses the offline key).
6. Publish the same file as `catalog.v1.json` on the host, and keep the bundled copy in the repo in step so offline installs list the same models.
7. To ship a new version of an existing model, raise `version`. Users see **Update available**; installing swaps atomically and drops the old file after the session is released.

### Conventions

- Single-file models: `urls` are the file URLs (first = primary, the rest are mirrors).
- Several files: each `urls` entry is a base folder and the file `path` is appended.
- Zip packages: `format: "zip"`, one archive in `files`, containing `model.onnx` at its root.
- A feature needs the `recommended` models of its feature id plus their `dependsOn`. Optional models should have `recommended: false`.

## Keys

The embedded public key (`config.rs`) is a **development key**. Before the first public release generate a production Ed25519 key, keep the private half offline, replace `CATALOG_PUBLIC_KEY`, re-sign the catalog, and rebuild. Rotating a key requires shipping a new app version; keep the old key's catalog reachable until users have updated.

## Using a model from a feature

```rust
// Rust: one warm session per model, shared by all features.
let session = state.sessions.get(&state.hub, "upscale-x4", device_key, |path| {
    inference::open_session(path, pref).map(|(s, _)| s)
})?;            // Err(ModelMissing(id)) when the model is not installed
```

```tsx
// React: banner + disabled controls until the model is ready.
<ModelInstallBanner requirement={{ feature: 'upscale' }} />
<ModelGate requirement={{ feature: 'upscale' }}>{/* controls */}</ModelGate>
```

For a model that depends on one choice (for example the upscaler per scale) pass `{ models: ['upscale-x4'] }` instead of the feature id.
