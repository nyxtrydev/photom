# PHOTOM: Vibe Coding Master Prompt

> Paste this entire document into your AI coding tool (Claude Code, Cursor, Windsurf, etc.) as the first message. Build **phase by phase**. Do not skip ahead. After each phase, stop, summarise what was done, run the acceptance checks, and wait for approval before continuing.

---

## 0. Role and Working Rules

You are a senior desktop application engineer (Rust + TypeScript) and UI engineer. You will build **Photom**, a fully offline desktop application that removes image backgrounds and exports transparent PNGs.

**Working rules (mandatory):**

1. Work strictly in the phases defined in Section 9. Complete one phase fully, then stop and report.
2. Before writing code in each phase, post a short plan (files to create or change).
3. Keep commits small and conventional (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`).
4. No placeholder logic presented as finished. If something is stubbed, mark it `// TODO(phase-N)` and list it in the phase report.
5. Never send user images or data over the network. The app is **offline-first**. No telemetry, no cloud inference.
6. All user-facing strings go through a single i18n-ready dictionary (English only for now).
7. Every Rust command must return `Result<T, AppError>` with a typed, serialisable error. No `unwrap()` in production paths.
8. Write tests alongside features, not at the end.
9. Follow the visual design in Section 6 exactly. Do not invent a different style.
10. Ask a question only when blocked. Otherwise choose the sensible default and note the decision in `docs/DECISIONS.md`.

---

## 1. Product Brief

| Item                 | Value                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **App name**         | Photom                                                                                                           |
| **Purpose**          | Remove image backgrounds locally, refine the result manually, and export transparent PNG files (single or batch) |
| **Platforms**        | Windows 10/11 first; macOS and Linux builds in Phase 6                                                           |
| **Launcher / shell** | **Tauri 2** (Rust core)                                                                                          |
| **Frontend**         | React 18 + TypeScript + Vite                                                                                     |
| **Inference**        | ONNX Runtime in the Rust backend (`ort` crate), bundled offline model                                            |
| **Target users**     | Small business owners, e-commerce sellers, designers, content creators                                           |

**Non-goals (v1):** cloud sync, user accounts, mobile apps, full photo-editing suite (layers, filters, text), video background removal.

**Key qualities:** private (offline), fast, simple, reliable (never lose work), and visually warm and polished.

---

## 2. Technology Stack (pin versions in the lockfiles)

**Shell and backend**

- Tauri 2.x, Rust stable (2021 edition or later)
- Crates: `ort` (ONNX Runtime), `image`, `imageproc`, `fast_image_resize`, `ndarray`, `serde`, `serde_json`, `thiserror`, `tokio`, `zip`, `uuid`, `chrono`, `tracing`, `tracing-subscriber`, `tracing-appender`, `dirs` (or Tauri path API), `rayon`
- Tauri plugins: `dialog`, `fs`, `store`, `window-state`, `updater`, `single-instance`, `os`, `clipboard-manager`

**Frontend**

- React 18, TypeScript (strict), Vite
- State: Zustand (with slices)
- Styling: Tailwind CSS driven by CSS variables (design tokens in Section 6)
- UI primitives: Radix UI (Dialog, Slider, RadioGroup, Tabs, DropdownMenu, Tooltip, Checkbox)
- Icons: `lucide-react`
- Canvas: HTML Canvas 2D with an offscreen canvas for mask editing (no heavy canvas framework)
- Testing: Vitest + React Testing Library; Playwright (or WebdriverIO with `tauri-driver`) for end-to-end; `cargo test` for Rust

**Tooling:** ESLint, Prettier, `cargo clippy -D warnings`, `cargo fmt`, GitHub Actions CI.

---

## 3. Architecture

### 3.1 High-level

```
+---------------------------- Tauri Window (frameless) ---------------------------+
|  React UI (TypeScript)                                                          |
|   - Screens, dialogs, canvas editor, Zustand stores                             |
|   - Thin API layer: src/api/*.ts  -->  invoke() / events                        |
+------------------------------- IPC (typed commands + events) -------------------+
|  Rust Core                                                                      |
|   - commands/      (IPC entry points, validation only)                          |
|   - services/      (inference, image_io, project, export, settings, history)    |
|   - models/        (DTOs, errors, enums)                                        |
|   - infra/         (model loader, paths, logging, job queue)                    |
+---------------------------------------------------------------------------------+
|  Local disk: app data dir (settings, history DB/JSON, autosave, logs, models)   |
+---------------------------------------------------------------------------------+
```

### 3.2 Folder structure

```
photom/
├─ src/                          # Frontend
│  ├─ app/                       # App shell, routing, providers, theme
│  ├─ screens/
│  │   ├─ Home/
│  │   ├─ Editor/
│  │   ├─ RemoveBackground/      # quick single-image flow
│  │   ├─ BatchProcess/
│  │   └─ History/
│  ├─ dialogs/                   # ExportDialog, BatchProgressDialog, SettingsDialog, ConfirmDialog
│  ├─ components/                # TitleBar, Sidebar, Toolbar, ToolRail, PropertiesPanel,
│  │                             # Filmstrip, StatusBar, BeforeAfterSlider, Checkerboard, etc.
│  ├─ canvas/                    # Viewport, MaskLayer, BrushEngine, Transform (zoom/pan), Compositor
│  ├─ stores/                    # projectStore, editorStore, settingsStore, queueStore, uiStore
│  ├─ api/                       # typed wrappers around Tauri invoke/listen
│  ├─ hooks/  utils/  types/
│  ├─ assets/                    # mascot, thumbnails, logo, fonts
│  └─ styles/                    # tokens.css, tailwind config
├─ src-tauri/
│  ├─ src/
│  │   ├─ main.rs  lib.rs
│  │   ├─ commands/              # image.rs, inference.rs, project.rs, export.rs, settings.rs, history.rs
│  │   ├─ services/              # inference.rs, preprocess.rs, postprocess.rs, image_io.rs,
│  │   │                         # project_file.rs, exporter.rs, autosave.rs, history.rs, settings.rs
│  │   ├─ infra/                 # model_manager.rs, job_queue.rs, paths.rs, logging.rs
│  │   ├─ models/                # dto.rs, error.rs
│  │   └─ tests/
│  ├─ resources/models/          # bundled ONNX model(s)
│  ├─ capabilities/              # Tauri 2 permission files (least privilege)
│  ├─ tauri.conf.json
│  └─ Cargo.toml
├─ docs/  (ARCHITECTURE.md, DECISIONS.md, DESIGN_TOKENS.md, PROJECT_FILE_FORMAT.md)
├─ .github/workflows/ci.yml  release.yml
└─ README.md
```

### 3.3 Responsibility boundaries

- **Frontend** owns presentation, canvas interaction (brush strokes, zoom, pan, slider) and UI state. It never decodes large images itself for inference.
- **Backend** owns decoding, resizing, inference, mask post-processing, compositing for export, file I/O, project packaging, settings, history, and logging.
- **Large data transfer:** do not pass big images as base64 JSON. Use file paths plus Tauri's asset protocol for display, and pass masks as raw bytes via `tauri::ipc::Response` (binary) or write to a temp file in the app cache dir and pass the path.

### 3.4 IPC contract (typed; mirror types in `src/types` and `models/dto.rs`)

| Command                                                               | Input                                                       | Output                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `import_images`                                                       | `paths: string[]`                                           | `ImageMeta[]` (id, path, width, height, format, thumbnail path) |
| `get_thumbnail`                                                       | `id`                                                        | thumbnail path                                                  |
| `remove_background`                                                   | `id`, `options: {model, device}`                            | `MaskResult` (mask path, bounding box, duration ms)             |
| `remove_background_batch`                                             | `ids[]`, `options`                                          | `jobId` (progress via events)                                   |
| `cancel_job` / `pause_job` / `resume_job`                             | `jobId`                                                     | `void`                                                          |
| `apply_mask_edit`                                                     | `id`, `strokes[]` (mode keep/erase, points, size, hardness) | updated mask path                                               |
| `refine_mask`                                                         | `id`, `{threshold, feather, edgeShift}`                     | preview mask (binary)                                           |
| `compose_preview`                                                     | `id`, `{background: transparent/solid/image}`               | preview image path                                              |
| `export_png`                                                          | `ids[]`, `ExportOptions`                                    | `jobId` (progress via events)                                   |
| `save_project` / `open_project` / `save_project_as`                   | project state / path                                        | `ProjectMeta`                                                   |
| `autosave_project`                                                    | project state                                               | `void`                                                          |
| `list_recovery` / `restore_recovery` / `discard_recovery`             | none / id                                                   | recovery entries                                                |
| `get_settings` / `update_settings`                                    | `Settings`                                                  | `Settings`                                                      |
| `list_history` / `clear_history` / `delete_history_item`              | none / id                                                   | `HistoryItem[]`                                                 |
| `get_model_status`                                                    | none                                                        | `{ready, activeModel, device, path}`                            |
| `list_export_presets` / `save_export_preset` / `delete_export_preset` | preset                                                      | presets                                                         |

**Events (backend to frontend):** `job:progress {jobId, done, total, currentId, state}`, `job:item-complete`, `job:error`, `model:status`, `autosave:done`.

### 3.5 Background removal pipeline (Rust)

1. **Decode** with the `image` crate. Apply EXIF orientation. Convert to RGB8.
2. **Preprocess:** resize to model input (ISNet general-use: 1024x1024; U2-Net: 320x320; BiRefNet: 1024x1024) using `fast_image_resize`; normalise (value/255, then mean/std per model); build an NCHW f32 tensor.
3. **Infer** with ONNX Runtime. Execution providers: CPU by default; try DirectML (Windows) / CUDA / CoreML when "GPU if available" is selected, and fall back to CPU gracefully with a logged warning.
4. **Postprocess:** take the output map, min-max normalise to 0..255, resize back to the original resolution (bilinear/Lanczos) as an 8-bit grayscale alpha mask.
5. **Refine (non-destructive):** threshold (soft), edge shift (erode/dilate), and feather (Gaussian blur on the mask edge). Parameters are stored with the image state; the raw model mask is kept untouched.
6. **Manual edits:** Keep/Erase brush strokes are stored as a separate edit layer composited over the model mask (`final = clamp(base_refined + keep - erase)`), so refine sliders and edits stay independent.
7. **Compose and export:** apply the final mask as the alpha channel on the original full-resolution RGB. Optional crop-to-subject (mask bounding box plus padding), optional resize, then PNG encode with the chosen compression level.

**Model handling**

- Bundle the **Fast** model (ISNet general-use or U2-Net, quantised if quality is acceptable) in `resources/models/`.
- **Quality** model (BiRefNet or ISNet full precision) is an optional download-free bundled or user-supplied file. Provide a `model_manager` that checks file presence and SHA-256, and shows a clear "model missing" state. Never download without an explicit user action, and keep a manual "Import model file" option so the app stays fully offline-capable.
- Load the session lazily once, keep it warm, and reuse it across images. Run inference on a worker thread (`spawn_blocking`) so the UI never freezes.

### 3.6 Concurrency and job queue

- A single `JobQueue` in `infra/job_queue.rs` handles batch removal and batch export.
- Supports queued, processing, done, failed, cancelled states plus pause/resume/cancel.
- Process sequentially by default (memory safe). Allow a configurable concurrency of 1 to 2 for CPU decode and encode only.
- Emit progress events at each item boundary. Failures on one item must not stop the batch; record the error and continue.

### 3.7 Error handling and logging

- `AppError` enum (`thiserror`) with variants: `Io`, `Decode`, `UnsupportedFormat`, `ModelMissing`, `ModelLoad`, `Inference`, `OutOfMemory`, `ProjectCorrupt`, `ExportFailed`, `Cancelled`, `Permission`. Serialise to `{code, message, details}`.
- Frontend maps codes to friendly messages and toasts, with a "Show details" expander.
- `tracing` logs to a rolling file in the app log dir; add a "Open logs folder" action in Settings > About.
- Guard against huge images: cap the working preview size and warn above a configurable pixel limit (default 100 MP).

---

## 4. Feature Specification

### 4.1 Import

- Open Images and Open Folder dialogs; drag-and-drop onto the Home drop zone and anywhere in the editor.
- Formats: PNG, JPG/JPEG, WEBP, BMP, TIFF. Reject others with a clear message.
- Multi-select, folder recursion (optional toggle), duplicate detection by path.
- Generate thumbnails in the background; show them in the Filmstrip.

### 4.2 Background removal

- **Remove BG** button (Ctrl+R) runs the model on the current image; show a non-blocking "Processing..." state in the status bar and disable conflicting actions.
- Result appears with the **Before | After** slider (draggable handle) and a checkerboard under transparent areas.
- Re-run with a different model or device from Settings > Model.

### 4.3 Refine and manual correction

- **Tool rail:** Move (select), Keep (restore brush), Erase (erase brush), Pan (hold Space also pans), Zoom.
- **Properties panel:** Threshold, Feather, Edge shift sliders (each with numeric input), Brush Size and Hardness, Background, Output.
- Brush cursor preview reflects size and hardness. Strokes are smooth (interpolated points, pressure support if a stylus is present).
- Zoom: wheel (Ctrl+wheel), fit-to-screen button, 25% to 800%, slider in the status bar. Pan with drag or Space.
- **Undo/Redo** (Ctrl+Z / Ctrl+Y): command-pattern history covering strokes, refine slider changes, background changes and model re-runs. Store stroke deltas (not full bitmaps) and cap memory with a configurable depth (default 50).

### 4.4 Background options

- **Transparent** (checkerboard preview), **Solid colour** (picker with hex input and recent colours), **Image** (choose a file; fit modes: cover, contain, stretch).
- Preview only affects the composition; export honours "Transparent" vs "Keep selected BG".

### 4.5 Export PNG (see Export dialog design)

- Scope: current image or all images (batch).
- Background: transparent or keep the selected background.
- Size: original or custom W x H with an aspect-ratio lock; high-quality resampling.
- Crop to subject with padding (px).
- PNG compression level slider.
- Filename template with tokens: `{name}`, `{index}`, `{date}`; default `{name}-photom.png`. Auto-suffix on conflict (never silently overwrite; ask or auto-number).
- Output folder picker; remembers the last folder; default export folder from Settings.
- **Presets** (e.g. Web, Print, Original): save, rename and delete custom presets.
- After export: toast with "Open folder" and "Copy path" actions.
- Also provide Copy to clipboard (PNG with alpha) for the current image.

### 4.6 Batch processing

- Triggered from the Batch Process screen, the Filmstrip, or the Export dialog with "All images".
- Batch dialog: overall progress bar with "N of M complete", per-item rows (thumbnail, filename, status chip: Done / Processing... / Queued / Failed), **Pause**, **Resume**, **Cancel**.
- Failed items show an error and offer Retry. A summary appears when the batch finishes.

### 4.7 History

- Records each completed export and each saved project: thumbnail, name, date/time, source path, output path.
- History screen: grid or list, search, open again, reveal in folder, delete, clear all.

---

## 5. Save, Persistence and Recovery

### 5.1 Project file: `.photom`

A single zip container (use the `zip` crate; store images without extra compression where already compressed):

```
project.photom
├─ manifest.json        # format version, app version, created/modified, image list
├─ images/<id>/original.<ext>   # embedded copy (option: link-only to save space)
├─ images/<id>/mask_model.png   # raw model mask (8-bit gray)
├─ images/<id>/mask_edits.png   # manual edit layer (8-bit gray or RGBA keep/erase)
├─ images/<id>/state.json       # refine params, background choice, crop/size, brush history summary
└─ thumbs/<id>.png
```

- `manifest.json` includes `formatVersion` with a **migration** function for future versions.
- Atomic saves: write to a temp file and rename; keep one `.bak` of the previous save.
- Validate on open; if corrupt, show a recoverable error rather than crashing.
- A project holds multiple images (matches the Filmstrip). The title bar shows `name.photom` with `*` when there are unsaved changes.

### 5.2 Save behaviours

- **Ctrl+S** save, **Ctrl+Shift+S** Save As, **Ctrl+O** open project, **Ctrl+N** new project.
- Unsaved-changes guard on close, New and Open (Save / Don't save / Cancel).
- First save of an untitled project opens the Save As dialog.

### 5.3 Autosave and crash recovery

- Autosave every N seconds (default 60, configurable in Settings) to `<appdata>/autosave/<project-id>.photom.tmp`, only when dirty. The status bar shows "Autosaved HH:MM".
- On startup, detect leftover autosaves and offer **Restore / Discard**.
- Autosave must never block the UI (run on a background task) and never overwrite the user's real file.

### 5.4 Settings store (Tauri store plugin, JSON)

`theme (dark/light/system)`, `autosaveSeconds`, `recentProjectsLimit`, `defaultExportFolder`, `modelType (fast/quality)`, `processing (cpu/gpuIfAvailable)`, `shortcuts` (map, user-remappable), `exportPresets`, `lastUsedFolders`, `windowState`, `undoDepth`, `pixelLimit`.

- Validate and migrate settings on load. "Reset to defaults" in Shortcuts and per section.

### 5.5 Recent projects

- Stored list (limit from Settings) with thumbnail, name, path, last-modified; missing files shown as unavailable with a "Remove" action. "Clear" empties the list.

---

## 6. UI/UX Specification

### 6.1 Design source of truth

The visual design has been provided as five mockups. Implement them faithfully:

1. **Home** (sidebar + hero drop zone + recent projects)
2. **Editor** (menu bar, toolbar, tool rail, canvas with Before/After slider, properties panel, filmstrip, status bar)
3. **Export PNG dialog**
4. **Batch Processing dialog**
5. **Settings dialog** (General, Model, Export, Shortcuts, About)

Place the exported mockup images in `docs/design/` (`01-home.png`, `02-editor.png`, `03-export.png`, `04-batch.png`, `05-settings.png`) and use them as visual references. If the files are missing, follow the layouts and tokens below.

### 6.2 Design tokens (define in `src/styles/tokens.css` and mirror in Tailwind)

| Token                | Light value (approximate)     | Usage                                                      |
| -------------------- | ----------------------------- | ---------------------------------------------------------- |
| `--bg-app`           | `#FBF6F0`                     | Window background                                          |
| `--bg-surface`       | `#FFFDFA`                     | Cards, panels, dialogs                                     |
| `--bg-muted`         | `#F3EBE1`                     | Secondary buttons, inputs                                  |
| `--border`           | `#E8DCCB`                     | Hairlines, dashed drop zone                                |
| `--primary`          | `#9A4A1F`                     | Primary buttons, active nav, slider fill, checked controls |
| `--primary-hover`    | `#843E19`                     | Hover/pressed                                              |
| `--primary-contrast` | `#FFFFFF`                     | Text on primary                                            |
| `--text`             | `#3B2415`                     | Headings and body                                          |
| `--text-muted`       | `#8A7767`                     | Secondary text, hints                                      |
| `--success`          | `#2E9E48`                     | Done states, "Model ready" dot                             |
| `--danger`           | `#C0392B`                     | Errors                                                     |
| `--radius-sm/md/lg`  | `8px / 12px / 18px`           | Controls / cards / dialogs                                 |
| `--shadow-card`      | soft, low-opacity warm shadow | Cards and dialogs                                          |

- **Typography:** serif display face for the "Photom" wordmark and dialog titles (e.g. Fraunces or Playfair Display, bundled locally); clean humanist sans for UI (e.g. Inter), bundled locally. No remote font loading.
- **Dark theme:** the mockups only show Light. Derive Dark by inverting surfaces to warm dark browns (`--bg-app ~ #1E1611`, `--bg-surface ~ #2A1F18`, `--text ~ #F3E7DB`) and lifting `--primary` slightly (`~ #C8672F`) for contrast. Meet WCAG AA contrast for text and controls in both themes. "System" follows the OS preference.
- **Checkerboard:** light-gray 8px squares, rendered in canvas and CSS; adapts in Dark.

### 6.3 Window

- Frameless custom title bar (`decorations: false`): logo plus "Photom" wordmark at left, Settings button and minimise / maximise / close at right; draggable region via `data-tauri-drag-region`. Remember size and position (window-state plugin). Minimum size ~ 1100 x 680.

### 6.4 Home screen

- **Left sidebar:** Home, Remove Background, Batch Process, Edit Image, History; bottom: Settings, About. Active item uses the filled `--primary` pill.
- **Hero:** dashed drop zone with icon, "Drag & drop images here", "or", **Open Images** (primary) and **Open Folder** (secondary), supported formats caption. Decorative mascot illustration and before/after dog card on the right (assets in `src/assets/illustrations/`).
- **Recent Projects:** card grid (thumbnail on checkerboard, filename, date/time, kebab menu: Open, Reveal in folder, Remove from list) with a **Clear** button.
- **Status bar:** green dot plus "Model ready (offline)" (or "Model missing" / "Loading model...").

### 6.5 Sidebar section definitions

- **Remove Background:** quick single-image flow (drop an image, auto-run, show Before/After, one-click Export PNG).
- **Batch Process:** multi-image queue management (add many, choose settings once, run, export all).
- **Edit Image:** the full editor workspace (Section 6.6).
- **History:** past exports and saved projects (Section 4.7).
- The editor opens as a **full-screen workspace** with a "Back to Home" action in the menu bar (no sidebar while editing).

### 6.6 Editor screen

- **Menu bar:** File (New, Open, Open Images, Save, Save As, Recent, Close), Edit (Undo, Redo, Reset refine, Clear edits), View (Zoom in/out, Fit, Actual size, Toggle checkerboard, Theme), Export (Export PNG, Batch export, Copy to clipboard), Help (Shortcuts, Open logs, About). Centre shows the project name with `*` when dirty.
- **Toolbar:** Open, Save, Undo, Redo (disabled states), divider, **Remove BG** (primary), **Export PNG** with dropdown (presets, Export all).
- **Tool rail (left):** Move, Keep, Erase, Pan, Zoom (icon plus label, active state highlighted).
- **Canvas (centre):** Before/After split view with a draggable handle and "Before" / "After" labels; toggle to single After view; checkerboard under transparency; brush cursor overlay.
- **Properties panel (right):** Background (Transparent / Solid colour / Image), Refine (Threshold, Feather, Edge shift), Brush (Size, Hardness), Output (Size with link-ratio, Crop to subject).
- **Filmstrip (bottom):** thumbnails with the active one outlined in `--primary`, plus an "Add Images" dashed tile; right-click: Remove from project, Reveal in folder, Re-run background removal.
- **Status bar:** Zoom % with minus / slider / plus / fit; image dimensions; colour mode (RGB); Autosaved time; job indicator ("Processing...") with expandable detail.

### 6.7 Dialogs

- **Export PNG:** exactly as the mockup (Scope, Background, Size with custom W x H and lock, Crop to subject with Padding, Compression slider, Filename, Folder with browse, Preset dropdown plus "Save as preset", Cancel / Export).
- **Batch Processing:** progress bar with percentage, "N of M complete", scrolling item list with status chips, Pause / Cancel; closes automatically or shows a summary when done.
- **Settings:** left tab list (General, Model, Export, Shortcuts, About). General: Theme, Autosave interval, Recent projects limit. Model: Fast (recommended) / Quality, Processing CPU / GPU if available with the helper note, model status and "Import model file". Export: default folder, default preset. Shortcuts: editable table with conflict detection and "Reset to defaults". About: version, licences (including the model licence), "Open logs folder", "Check for updates".

### 6.8 Required states (design in the same visual style)

- **Empty states:** no recent projects, empty filmstrip, empty History.
- **Loading:** model loading skeleton, image decoding spinner, processing overlay on the canvas.
- **Errors:** unsupported file, corrupt project, model missing, out of memory, export failure, each with a clear action.
- **Confirmations:** unsaved changes, overwrite file, clear history, discard autosave.
- **Toasts:** success (with "Open folder"), warning, error.

### 6.9 Default keyboard shortcuts (remappable)

`Ctrl+O` Open images, `Ctrl+Shift+O` Open project, `Ctrl+S` Save, `Ctrl+Shift+S` Save As, `Ctrl+R` Remove background, `Ctrl+E` Export PNG, `Ctrl+Z` Undo, `Ctrl+Y` / `Ctrl+Shift+Z` Redo, `V` Move, `B` Keep brush, `E` Erase brush, `H` or hold `Space` Pan, `Z` Zoom, `[` `]` brush size, `Ctrl+0` Fit, `Ctrl+1` 100%. Use `Cmd` on macOS.

### 6.10 Accessibility

Full keyboard navigation, visible focus rings, ARIA labels on icon buttons and sliders, respects reduced-motion, and minimum contrast AA.

---

## 7. Performance Targets

- Cold start to interactive UI: under 2 seconds (excluding first model load).
- 12 MP image background removal on a typical laptop CPU: under 6 seconds (Fast model); noticeably faster with GPU.
- Brush strokes: 60 fps on a 12 MP image (edit on a downscaled working mask, apply to full resolution on commit).
- Memory: release image buffers when switching images; keep only the active image at full resolution plus thumbnails. Stream batch items one at a time.
- Installer size target: under 150 MB including the Fast model.

---

## 8. Security and Privacy

- Tauri 2 **capabilities**: grant only the permissions used (dialog, scoped fs access to user-chosen paths and app data dirs, store, updater). No broad shell or network permissions.
- Strict CSP; no remote scripts, no remote fonts or images.
- Validate every path and size received over IPC; canonicalise paths; never execute user-supplied paths.
- No analytics, no crash upload. Logs stay local and exclude image content.
- The updater (Phase 6) uses signed releases and is **opt-in** with a visible "Check for updates" action, because the app is otherwise fully offline.
- Document third-party licences (model, ONNX Runtime, crates, fonts) in About and in `THIRD_PARTY_LICENSES.md`. Choose a model whose licence permits commercial redistribution and record it in `docs/DECISIONS.md`.

---

## 9. Phased Roadmap with Acceptance Criteria

> After every phase: run lint, type-check, unit tests and a manual smoke test; update `docs/ARCHITECTURE.md`; write a short phase report; **stop and wait for approval.**

### Phase 0: Foundation and scaffolding

**Build:** Tauri 2 + React/TS/Vite project; folder structure from 3.2; Tailwind with tokens; fonts bundled; frameless window with custom title bar (drag, min/max/close); window-state persistence; ESLint/Prettier/clippy/fmt; GitHub Actions CI (lint, test, build on Windows); typed IPC skeleton with a `ping` command; `AppError` and logging; Zustand store skeletons; Light/Dark theme switch.
**Acceptance:** `npm run tauri dev` opens the frameless window with the correct palette and fonts; the title bar buttons work; theme toggles; CI is green; `ping` round-trips with typed errors.

### Phase 1: Home screen, import and the removal engine

**Build:** Home screen per mockup (sidebar, drop zone, recent projects placeholder, status bar); Open Images / Open Folder / drag-and-drop; image decoding, EXIF orientation, thumbnails; model manager and lazy ONNX session; full pipeline in 3.5 (preprocess, inference, postprocess) behind `remove_background`; CPU first, GPU provider with fallback; unit tests with fixture images (mask dimensions, alpha range, determinism); status bar model state.
**Acceptance:** Dropping a JPG and invoking removal produces a correct alpha mask at original resolution within the target time; unsupported files are rejected gracefully; the UI stays responsive during inference.

### Phase 2: Editor canvas and refine tools

**Build:** Editor screen layout (menu, toolbar, tool rail, canvas, properties, filmstrip, status bar); viewport with zoom and pan; checkerboard; Before/After slider; Keep/Erase brush engine with size and hardness and a cursor preview; Threshold / Feather / Edge shift (non-destructive); Background options (transparent, solid, image); multi-image Filmstrip with switching.
**Acceptance:** Smooth 60 fps brushing on a 12 MP image; refine sliders update the preview in under 200 ms; switching images preserves each image's state; Before/After slider behaves correctly at all zoom levels.

### Phase 3: Projects, save, undo/redo, settings

**Build:** `.photom` format (Section 5.1) with atomic save, `.bak`, versioning and migration; New / Open / Save / Save As; dirty tracking and unsaved-changes guards; autosave and crash recovery; recent projects with thumbnails and Clear; undo/redo command history; full Settings dialog (General, Model, Export, Shortcuts incl. remapping, About); persisted settings with validation.
**Acceptance:** Close and reopen a project with identical results; kill the process mid-edit and recover from autosave; undo/redo works across strokes, sliders and background changes; settings persist across restarts; a corrupt project opens with a clear recovery message.

### Phase 4: Export and batch processing

**Build:** Export PNG dialog per mockup (scope, background, size, crop-to-subject with padding, compression, filename tokens, folder, presets); full-resolution compose and encode path; copy-to-clipboard; job queue with Pause / Resume / Cancel; Batch Processing dialog; Batch Process screen; History screen and records; "Open folder" toasts.
**Acceptance:** Exported PNGs have correct alpha and exact requested dimensions; the crop padding is exact; a batch of 40 images completes with per-item status, a failed item does not stop the batch, and Cancel stops cleanly; no file is overwritten silently.

### Phase 5: Polish, performance and quality

**Build:** All empty, loading, error and confirmation states (Section 6.8); Dark theme refinement; keyboard shortcuts everywhere; accessibility pass; performance profiling and memory optimisation (large images, long batches); the Remove Background quick-flow screen; Quality model selection and model import flow; full test suite (unit, component, end-to-end for import, remove, edit, save, export); fix all clippy and ESLint warnings.
**Acceptance:** All Section 7 targets met or documented with measurements; end-to-end tests pass on Windows; no console errors; keyboard-only usage possible for the core flow.

### Phase 6: Packaging, release and cross-platform

**Build:** Windows installer (NSIS/MSI) with icons and file association for `.photom`; macOS (.dmg) and Linux (AppImage/deb) builds in CI; code-signing setup documentation; opt-in signed auto-update; third-party licence bundle; version and changelog automation; README with build, run and contribution guides; release workflow producing artifacts on tag.
**Acceptance:** A clean Windows machine installs and runs Photom fully offline; double-clicking a `.photom` file opens it; macOS and Linux builds launch and pass the smoke test; the update check works against a test release.

---

## 10. Testing and Quality Checklist

- **Rust:** unit tests for preprocess/postprocess, mask math (threshold, feather, edge shift, composition), project file round-trip and migration, filename templating, export sizing/cropping, job queue state machine.
- **Frontend:** component tests for dialogs and panels; store tests; brush engine tests on small buffers.
- **End-to-end:** import, remove, refine, save, reopen, export, batch, recovery.
- **Fixtures:** include small test images (portrait, product on white, complex hair/fur, transparent PNG input, very large image, CMYK/16-bit TIFF, EXIF-rotated JPG).
- **Edge cases to handle explicitly:** images with existing alpha, 16-bit and CMYK inputs, extreme aspect ratios, very large images, read-only output folders, low disk space, paths with unicode and spaces, cancelled dialogs, and rapid repeated actions.
- **Definition of done for any feature:** typed end to end, error paths handled, tested, accessible, matches the design, documented in `docs/`.

---

## 11. Deliverables (final)

1. Complete source code in the structure above.
2. `README.md` (setup, development, build, packaging) and `docs/` files (ARCHITECTURE, DECISIONS, DESIGN_TOKENS, PROJECT_FILE_FORMAT).
3. Test suite plus CI workflows.
4. Release artifacts per platform.
5. `THIRD_PARTY_LICENSES.md`.

---

## 12. Start Instruction

Begin with **Phase 0 only**. First post a brief plan listing the files you will create and any decisions you are making, then implement. When Phase 0 meets its acceptance criteria, stop and report: what was built, how to run it, test results, and any open decisions. Do not begin Phase 1 until you receive explicit approval.
