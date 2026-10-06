# Architecture

See the master prompt (Section 3) for the target design. Current state: **Phase 0**.

- `src/` React UI. `src/api/` is the only place that calls Tauri (`invoke.ts` normalises all failures to `AppError`).
- `src-tauri/src/commands/` IPC entry points (validation only). `models/` holds `AppError` + DTOs, mirrored in `src/types/`.
- `infra/logging.rs` writes daily-rolling logs to the app log dir (never image content).
- Window is frameless (`decorations: false`); `TitleBar` provides drag region + min/max/close.
- Theme: `data-theme` on `<html>` set by `useApplyTheme`; tokens in `src/styles/tokens.css`, mapped in `tailwind.config.ts`.

## IPC implemented

| Command | Input             | Output                                                |
| ------- | ----------------- | ----------------------------------------------------- |
| `ping`  | `message: string` | `PingResponse` or `AppError(InvalidInput)` when blank |

## Phase 1: import and removal engine

- `AppState` (`state.rs`): image registry (id -> source path, thumbnail, mask), shared `InferenceEngine`, `ModelManager`, cache dir.
- `services/image_io.rs`: header read, EXIF-oriented decode, pixel cap (100 MP), thumbnails, mask save, bounding box. Images with alpha are composited over white for inference.
- `services/preprocess.rs` / `postprocess.rs`: Lanczos resize to the model size, `v/255` then mean/std, NCHW f32; output min-max normalised to 8-bit then bilinear-resized to source size.
- `services/inference.rs`: one lazily loaded, warm `ort` session behind a mutex. "GPU if available" tries DirectML (Windows) / CoreML (Apple Silicon) and falls back to CPU with a warning.
- `infra/model_manager.rs`: model specs, search order (user models dir, bundled resources, dev tree), SHA-256 verification at load.
- Large data stays on disk: thumbnails and masks live in the app cache dir and are shown through the asset protocol (scope `$APPCACHE/**`).
- Home screen shows imported images with a Remove BG action (cut-out preview = thumbnail masked by the alpha mask). The editor replaces this in Phase 2.

| Command             | Input                                 | Output                                             |
| ------------------- | ------------------------------------- | -------------------------------------------------- |
| `import_images`     | `paths: string[]`, `recursive?: bool` | `ImportResult { images, rejected }`                |
| `get_thumbnail`     | `id`                                  | thumbnail path                                     |
| `remove_background` | `id`, `options { model, device }`     | `MaskResult` (mask path, bbox, durationMs, device) |
| `get_model_status`  | `model?`                              | `ModelStatus`                                      |

Events: `model:status`.

## Phase 2: editor

- **Working resolution:** the backend prepares a downscaled preview (JPEG) and a downscaled copy of the raw model mask (`prepare_working_set`, longest side 2048). The frontend edits at that size; units that depend on image size (feather, edge shift, brush size) are stored in SOURCE pixels and scaled by `work/source`, so previews match full-resolution export.
- **Pixel data over binary IPC:** `read_cache_file` returns raw bytes (no base64, no CORS/tainted canvas), restricted to the app cache dir.
- `src/canvas/`: `viewport.ts` (zoom/pan maths), `maskOps.ts` (soft threshold, erode/dilate, Gaussian via box blurs, compose), `brush.ts` (dab stamping, `StrokePainter`, replay), `session.ts` (`MaskSession`: working buffers for one image, disposed on image switch), `compositor.ts` (draws checker/background/Before-After), `EditorCanvas.tsx` (imperative rAF render, pointer and wheel input, split handle, brush cursor).
- **Mask model:** `final = clamp(refine(base) + delta)`. `delta` is an Int16 edit layer: Keep raises toward +255, Erase lowers toward -255, a later opposite stroke overrides. Strokes are stored as deltas (points in source px, with pen pressure) and replayed for undo/redo; live painting and replay share `StrokePainter`, so results are identical.
- **Undo/redo:** command pattern per image (`editorStore`): strokes, refine (one step per slider drag), background/output (rapid edits merged), clear edits, model re-run (each run writes its own mask file; `set_active_mask` switches back). Depth from `settings.undoDepth` (default 50).
- **Input:** Ctrl/Cmd+wheel zooms at the cursor, plain wheel pans, Space or the Pan tool drags, Zoom tool clicks in (Alt out).
- **Tests:** unit tests for maths and stores; Playwright (`npm run e2e`) drives the real UI in Chromium against the Vite dev server with a mocked Tauri IPC (`e2e/tauriMock.ts`) and asserts canvas pixels.

IPC added: `prepare_working_set`, `prepare_background_image`, `read_cache_file`, `reveal_in_folder`, `set_active_mask`.

## Phase 3: projects, persistence, settings

- **Project file** (`services/project_file.rs`): see `PROJECT_FILE_FORMAT.md`. Commands: `save_project` / `save_project_as`, `open_project`, `project_backup_path`, `reset_session`, `autosave_project`, `list_recovery`, `restore_recovery`, `discard_recovery`.
- **Settings** (`services/settings.rs`, `commands/settings.rs`): pure parse/validate/migrate (field-by-field tolerant: one bad value falls back to its default), persisted with the Tauri store plugin (`settings.json`). `AppState.settings` is the in-memory copy; the pixel limit setting feeds import, decoding and previews. Recent projects (with thumbnails copied to `<app data>/recent`) live in settings.
- **Frontend lifecycle** (`hooks/useProjectLifecycle.ts`, `app/projectActions.ts`): dirty tracking (images or persisted editor state changed; view changes are not edits), background autosave only while dirty, window close guard (Save / Don't save / Cancel via `ask()` + `ConfirmDialog`), startup recovery dialog, `.photom` files dropped on the window open as projects.
- **Shortcuts** (`app/shortcuts.ts`): defaults + user overrides from settings, conflict detection, key recorder in Settings > Shortcuts. Overrides store only differences from the defaults.
- **Editor state sanitising** (`stores/persist.ts`): all saved editor state is validated and clamped on load.

## Phase 4: export, batch, history

- **Export pipeline** (`services/exporter.rs`): decode the source (EXIF-oriented, RGBA) and the raw model mask at full resolution -> `refine` + replayed brush strokes (ports of the editor maths in `services/maskops.rs` / `services/brush.rs`) -> alpha (multiplied with any alpha the source already had) -> optional crop to the subject (mask >= 10) with exact padding, extending the canvas with transparent pixels when the subject touches the image edge -> premultiplied Lanczos resize to the exact target size (or a `maxSide` cap, never upscaling) -> optional compositing over the selected background (solid colour / picture with cover, contain, stretch) -> PNG (level 0..9; opaque images are stored as RGB).
- **Parity guarantee:** `src/canvas/parity.test.ts` writes `src-tauri/tests/fixtures/mask_parity.json` from the TypeScript preview maths; `src/tests/parity.rs` checks the Rust maths against it (max difference 1 level). Change either side and one of the two tests fails.
- **Safe file names** (`expand_template`, `sanitize_file_name`, `write_unique`): tokens `{name}`, `{index}` (zero-padded to the batch size), `{date}`; separators/reserved characters/Windows device names are neutralised; `.png` is enforced. Files are claimed with `create_new`, so an existing file is never replaced, even by concurrent exports; a ` (2)`, ` (3)` suffix is added instead. Read-only folders and a full disk give plain-language errors.
- **Job queue** (`infra/job_queue.rs`): one queue for batch export and batch removal. States queued/processing/done/failed/cancelled; pause/resume/cancel; 1 or 2 workers (setting `exportConcurrency`); a failing or panicking item fails only itself; cancel lets the running item finish (no partial files) and marks the rest cancelled. Events: `job:progress`, `job:item-complete`, `job:error`. The frontend treats events as triggers and reads `get_job` snapshots, so late/early events cannot desynchronise the UI.
- **History** (`services/history.rs`): JSON in the app data dir, newest first, capped at 500, with thumbnails in `<app data>/history`. Written by exports and by project saves.
- **Presets:** built-ins (Web, Print, Original) live in the frontend; custom ones are stored in settings via `save_export_preset` / `delete_export_preset` and are matched back to the current options so the dropdown always shows the truth.
- **Clipboard:** `copy_to_clipboard` renders with the same pipeline and writes RGBA through the clipboard-manager plugin.

IPC added: `export_png`, `remove_background_batch`, `cancel_job`, `pause_job`, `resume_job`, `get_job`, `copy_to_clipboard`, `list_history`, `delete_history_item`, `clear_history`, `list_export_presets`, `save_export_preset`, `delete_export_preset`.

## Phase 5: polish, accessibility, performance

- **Errors:** every failure goes through `reportError()` (`app/errors.ts`): a friendly title, the technical text behind "Show details", a hint for the code (e.g. offline model, memory), and a next-step action (Open model settings / Open settings). Toasts auto-dismiss (success/info 6 s, warnings 10 s) but never while hovered/focused; errors stay until dismissed. Roles: `alert` for problems, `status` for good news.
- **Model**: `ModelSpec` lists acceptable files in preference order (fp16, fp32); a user-imported model is stored as `custom-<kind>.onnx` and wins. Status bar opens Settings > Model when the model needs attention.
- **Quick flow** (`screens/RemoveBackground.tsx`): choose/drop one image, the cut-out runs automatically once, Before/After via the same `EditorCanvas`, one-click export, "Fine-tune in editor".
- **Accessibility:** WCAG AA contrast for every token pair in both themes is unit-tested (`styles/contrast.test.ts`); axe-core audits every screen/dialog/menu in light and dark with zero violations (`e2e/a11y.spec.ts`); keyboard-only core flow, focus trap/restore (`hooks/useRestoreFocus.ts`), visible focus rings and `prefers-reduced-motion` are e2e-tested (`e2e/keyboard.spec.ts`). Menus are non-modal so the page behind them is not `aria-hidden` while still focusable.
- **No console errors:** every e2e test runs inside a fixture (`e2e/base.ts`) that fails on `console.error` or an uncaught exception.
- **Performance:** see `PERFORMANCE.md`.

## Phase 6: packaging and release

- **Bundles** (`tauri.conf.json`): NSIS + MSI (Windows), DMG (macOS), AppImage + deb (Linux); `.photom` file association; icons generated from the logo. Overrides: `tauri.release.conf.json` (ship only the fp16 model + licences), `tauri.offline-webview.conf.json` (embed WebView2), `tauri.macos-x64.conf.json` (bundle the ONNX Runtime library for Intel Macs).
- **Opening files from the OS** (`launch.rs`): command-line argument or a second launch (single-instance) or macOS `RunEvent::Opened` go through `launch::deliver`: an `app:open-file` event once the UI is listening, otherwise stored until the frontend calls `take_launch_file`.
- **Updater** (`commands/updates.rs`): `check_for_update` / `install_update` / `restart_app`, signature-verified, opt-in, with a test suite that runs the real updater against a local fake release server (`updates_tests.rs`).
- **Smoke test** (`smoke.rs`): `photom --smoke-test` runs import -> cut-out -> export inside the real app; CI runs it on every platform and against the installed release artifacts.
- **Licences:** `scripts/gen-licenses.mjs` builds `THIRD_PARTY_LICENSES.md` from `cargo tree` and `npm ls` (offline); it is bundled and viewable in Settings > About.
- **Release tooling:** `scripts/bump-version.mjs` (one version across package.json, Cargo.toml and tauri.conf.json), `scripts/changelog.mjs` (conventional commits to CHANGELOG.md and release notes), both with unit tests in `scripts/lib/`. Workflows: `.github/workflows/ci.yml` (lint, tests, e2e on Windows, build + smoke on three OSes) and `release.yml` (tag -> signed installers + `latest.json`, then smoke-tests the published installers).
- See `RELEASING.md` for signing, secrets and the release procedure.
