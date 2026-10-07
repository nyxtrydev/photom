# PHOTOM Feature 0: Model Hub (One-Click Model Installation)

> Build this feature **first**. Features 1 to 4 (Text Removal, Shadow, Upscaler, Enhancement) depend on it. Paste this document into your coding tool as a new task on the existing Photom codebase (Tauri 2, React + TypeScript, Rust backend, ONNX Runtime, job queue, `.photom` projects, Zustand, design tokens). Work phase by phase and stop for approval after each phase.

---

## 0. Working Rules
1. Extend the existing architecture. Do not rewrite working code. Reuse `AppError`, `JobQueue`, logging, settings store, design tokens and dialog components.
2. Keep the app **offline-first**. The only network activity allowed is downloading a model file or the model catalog after an explicit user action (or the optional "check for model updates" action). No images, usage data or telemetry are ever transmitted.
3. All downloads run in the **Rust backend**. The web layer gets no network permission and the CSP stays strict.
4. Small conventional commits. Tests alongside code. Record decisions in `docs/DECISIONS.md`.
5. Stop after each phase, report, and wait for approval.

---

## 1. Goal
Every AI model used by Photom can be installed with a single **Install now** click, anywhere in the app where it is needed, with reliable progress, resume, verification and clean failure handling. Once installed, models work fully offline.

The bundled **Fast** background-removal model stays inside the installer so core features work from first launch. Everything else is installable.

---

## 2. Model Catalog (manifest)

### 2.1 Hosting
- Default host: **GitHub Releases or a Nyxtry-controlled CDN** (one release or folder per model version). Hosting models ourselves lets us confirm each licence permits redistribution and avoids broken third-party links.
- The catalog URL and mirror URLs are **constants in one config file** (`src-tauri/src/model_hub/config.rs`) and also overridable in Settings > Advanced for restricted networks. Placeholder: `https://models.photom.example/catalog.v1.json` (replace with the real URL).
- A **bundled fallback catalog** ships inside the app so the Models page can list models even when offline (showing "Catalog may be out of date").

### 2.2 Manifest schema (`catalog.v1.json`)
```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-06T00:00:00Z",
  "models": [
    {
      "id": "text-detector-dbnet",
      "name": "Text Detector",
      "feature": "text-removal",
      "version": "1.0.0",
      "description": "Finds text regions automatically.",
      "sizeBytes": 0,
      "sha256": "<hex>",
      "format": "onnx",
      "files": [
        { "path": "model.onnx", "sizeBytes": 0, "sha256": "<hex>" }
      ],
      "urls": ["https://primary.example/...", "https://mirror.example/..."],
      "license": { "name": "Apache-2.0", "url": "https://...", "commercialUse": true, "attribution": "..." },
      "requirements": { "minRamMb": 2048, "gpuOptional": true },
      "runtime": { "inputSize": [640, 640], "normalization": "imagenet", "notes": "" },
      "recommended": true,
      "dependsOn": []
    }
  ],
  "signature": "<base64 Ed25519 signature over the canonical JSON of the models array>"
}
```
- The manifest is **signed with Ed25519**. The public key is embedded in the app (`ed25519-dalek`). Reject any catalog with a missing or invalid signature and fall back to the bundled catalog with a warning.
- Models are single files or small multi-file sets. Archives (`.zip`) are allowed only if extraction is path-sanitised (reject `..`, absolute paths and symlinks).

### 2.3 Initial catalog entries (create with placeholder hashes; fill from real files)
| id | Feature | Typical model | Approx. size | Licence to verify |
|---|---|---|---|---|
| `bgremoval-fast` | Background removal | ISNet general-use (bundled) | bundled | Apache-2.0 |
| `bgremoval-quality` | Background removal | BiRefNet | 200 to 900 MB | MIT |
| `text-detector` | Text Removal | DBNet or CRAFT text detector | 5 to 100 MB | Apache-2.0 / MIT |
| `inpaint-lama` | Text Removal | LaMa (big-lama), ONNX | 100 to 200 MB | Apache-2.0 |
| `upscale-x2` | Upscaler | Real-ESRGAN x2 (general) | 30 to 70 MB | BSD-3-Clause |
| `upscale-x4` | Upscaler | Real-ESRGAN x4 (general) | 30 to 70 MB | BSD-3-Clause |
| `upscale-x4-anime` | Upscaler | Real-ESRGAN anime x4 (optional) | 10 to 20 MB | BSD-3-Clause |
| `denoise-ai` | Enhancement | NAFNet or SwinIR denoise (optional) | 30 to 120 MB | MIT / Apache-2.0 |

**Licence rule:** before adding any model to the public catalog, confirm its licence permits redistribution and commercial use. Do **not** include models with non-commercial licences (for example, some face-restoration weights). Record each licence check in `docs/DECISIONS.md` and show the licence in the UI.

---

## 3. Architecture

### 3.1 Rust module layout
```
src-tauri/src/model_hub/
├─ config.rs        # catalog URLs, allowed hosts, limits, public key
├─ manifest.rs      # parse, validate, signature verify, version compare
├─ registry.rs      # installed-model registry (JSON in app data), state machine
├─ downloader.rs    # streaming download, Range resume, mirrors, retries, speed/ETA
├─ verifier.rs      # SHA-256 streaming verify, size check
├─ installer.rs     # atomic install, archive extraction, remove, import local file
├─ session_cache.rs # lazy ONNX session creation per model, reuse, unload on removal
└─ commands.rs      # IPC entry points
```

### 3.2 Storage
```
<appdata>/models/
├─ registry.json                 # installed models, versions, paths, hashes, installedAt
├─ .downloads/<id>-<ver>.part    # in-progress downloads (resumable)
└─ <id>/<version>/               # final location
   ├─ model.onnx
   └─ meta.json
```
- Downloads go to `.part`, are **hash-verified**, then moved with an atomic rename. A crash or cancel never leaves a half-installed model visible.
- Check **free disk space** (required size plus a safety margin) before starting.

### 3.3 State machine
`NotInstalled → Queued → Downloading → Verifying → Installing → Installed`
Side states: `Paused`, `Failed(error)`, `UpdateAvailable`, `Removing`.
- Resume from `.part` using HTTP `Range`; fall back to a full restart if the server does not support ranges.
- Retry transient errors with exponential backoff (3 attempts), then try the next mirror, then fail with a clear message.

### 3.4 Downloader requirements
- `reqwest` with **rustls**, HTTPS only, streaming body, system proxy support, connect and read timeouts.
- **Host allowlist:** only hosts in `config.rs` (and the user override in Advanced). Re-check the host after every redirect.
- Enforce the manifest `sizeBytes` as the maximum (abort if the server sends more).
- Emit `model:progress {id, downloadedBytes, totalBytes, speedBps, etaSeconds}` at most every 250 ms.
- Concurrency: one model at a time by default; the rest queue. Never block the UI thread.

### 3.5 IPC contract
| Command | Input | Output |
|---|---|---|
| `models_list` | none | `ModelInfo[]` (catalog merged with installed state) |
| `models_refresh_catalog` | none | updated list, plus `catalogSource: remote or bundled` |
| `model_install` | `id` | void (progress via events) |
| `model_install_many` | `ids[]` | void |
| `model_install_recommended` | none | void |
| `model_pause` / `model_resume` / `model_cancel` | `id` | void |
| `model_remove` | `id` | void |
| `model_import_file` | `id`, local path | void (verify against manifest hash, or warn "unverified") |
| `model_open_folder` | none | void |
| `model_check_requirements` | `featureId` | `{ready: bool, missing: ModelInfo[]}` |

**Events:** `model:state {id, state}`, `model:progress {...}`, `model:error {id, code, message}`, `catalog:updated`.

### 3.6 Integration with inference
- Every feature service obtains its session through `session_cache::get(model_id)`. If the model is not installed, return `AppError::ModelMissing { id }` so the UI can show the Install prompt instead of a generic error.
- Removing a model first unloads its session. Installing a newer version swaps atomically and invalidates the cached session.
- The existing bundled background-removal model is registered in the registry with `source: "bundled"` (not removable). `bgremoval-quality` becomes an installable model.

---

## 4. UI/UX (match the existing warm terracotta design tokens)

### 4.1 Reusable component: `ModelInstallBanner`
Shown inside any feature panel whose model is missing.
```
+------------------------------------------------------------+
| (icon) Text Removal needs 2 models (about 140 MB total)    |
|        Works offline after install.                        |
|                       [ Install now ]   [ Details ]        |
+------------------------------------------------------------+
```
States inside the same component:
- **Downloading:** progress bar, "42 MB of 140 MB, 6.2 MB/s, about 16 s left", **Pause** and **Cancel**.
- **Paused:** "Paused at 42 MB", **Resume**.
- **Verifying / Installing:** indeterminate bar with the label.
- **Failed:** friendly message, **Retry**, **Details** (error code, mirror tried).
- **Installed:** the banner disappears and the feature controls become enabled.
Feature controls stay visible but **disabled with a tooltip** until the model is ready. Provide a hook `useModelRequirement(featureId)` returning `{ready, missing, install, progress}`.

### 4.2 Settings > Models page
- Table or card list: name, feature, version, size, licence, status chip (Not installed / Downloading / Installed / Update available), actions (**Install**, **Pause**, **Resume**, **Remove**, **Update**).
- Header actions: **Install recommended**, **Install all**, **Check for updates**, **Import model file**, **Open models folder**.
- Footer: "Installed models use X GB on disk." and a catalog source note ("Online catalog" or "Offline catalog (bundled)").
- Details drawer: description, licence link, attribution text, file hashes, requirements.

### 4.3 First-run and status bar
- First launch: a friendly dialog offering **Install recommended models** or **Skip for now** (never forced). Not shown again after a choice (a setting can re-enable it).
- Status bar chip shows an active download ("Downloading Upscaler 62%") and opens the Models page on click.
- A toast on completion: "Image Upscaler is ready" with an **Open** action.

### 4.4 Required states
- **No internet:** "You are offline. Connect to download, or import a model file." plus the Import button.
- **Disk full:** shows required vs available space.
- **Hash mismatch:** "The download was corrupted and has been discarded." with Retry.
- **Blocked or proxy errors:** a clear message and a link to Advanced settings.
- Accessibility: keyboard operable, ARIA live region for progress, AA contrast in Light and Dark.

---

## 5. Security and Privacy
- HTTPS only, host allowlist (checked on redirects), signed catalog, SHA-256 verification of every file, size caps, sanitised paths, no execution of downloaded content (models are data files only).
- **Imported files** that cannot be verified against the manifest hash require an explicit "I understand this file is unverified" confirmation and are marked "Unverified" in the UI.
- Tauri capabilities: no new web-layer network permission. The backend alone opens connections.
- Logs record model id, status and error codes only, never file paths from the user's images.

---

## 6. Phases and Acceptance Criteria
After each phase: lint, type-check, tests, manual smoke test, update `docs/ARCHITECTURE.md`, short report, stop for approval.

### Phase H0: Registry, manifest and state machine
**Build:** module layout; manifest parsing and Ed25519 verification; bundled fallback catalog; `registry.json` persistence; state machine and events; `models_list`, `model_check_requirements`; register the bundled background model.
**Acceptance:** the catalog loads from the bundled file; a tampered manifest is rejected; states persist across restarts.

### Phase H1: Downloader and installer
**Build:** streaming downloader with resume, mirrors, retries, speed/ETA; SHA-256 verify; atomic install; disk-space check; pause/resume/cancel; remote catalog refresh.
**Acceptance:** a multi-hundred-MB test model downloads, survives a mid-download app kill and resumes, passes hash check, and installs atomically; a corrupted file is discarded; a mirror failover works.

### Phase H2: UI
**Build:** `ModelInstallBanner`, `useModelRequirement`, Settings > Models page, first-run dialog, status bar chip, toasts, all states in 4.4.
**Acceptance:** from a clean profile, a feature panel shows the banner, **Install now** completes the install, and the feature unlocks without restarting the app.

### Phase H3: Import, update, remove, advanced
**Build:** `model_import_file` with the unverified flow; update detection and "Update available"; remove with session unload; Advanced settings (catalog URL, host override, proxy note); install-many and recommended.
**Acceptance:** remove then reinstall works; updating a model replaces the old version atomically and clears the session cache.

### Phase H4: Tests and polish
**Build:** Rust tests with a mock HTTP server (`wiremock`): resume, range unsupported, hash mismatch, size overflow, redirect to a disallowed host, disk-full simulation, state-machine transitions; frontend component tests for all banner states; an end-to-end test of the install flow using a small fixture model.
**Acceptance:** all tests green on CI; no console errors; offline behaviour verified (installed models work with the network disabled).

---

## 7. Start Instruction
Begin with **Phase H0 only**. Post a short plan (files to create or change, decisions made), implement, then stop and report. Do not start Phase H1 until you receive explicit approval.
