# PHOTOM Feature 3: Image Upscaler (Improve Low-Resolution Images)

> Prerequisite: **Feature 0 (Model Hub)** is implemented. Paste this into your coding tool as a new task on the existing Photom codebase. Work phase by phase and stop for approval after each phase.

---

## 0. Working Rules
1. Extend the existing architecture (Tauri 2, React + TypeScript, Rust, ONNX Runtime, `JobQueue`, `.photom` projects, undo/redo, Zustand, design tokens, Model Hub). Do not rewrite working code.
2. Fully offline after the models are installed. No image data leaves the device.
3. Models come only from the Model Hub with the **Install now** flow. This feature never downloads anything itself.
4. Non-destructive: the original is preserved; the upscaled result is stored as a derived asset in the project.
5. Small conventional commits, tests alongside code, decisions in `docs/DECISIONS.md`. Stop after each phase for approval.

---

## 1. Purpose
Increase the resolution and apparent detail of low-resolution images by **2x or 4x** using AI super-resolution, with a fast classical fallback, and preserve clean edges on transparent cut-outs.

---

## 2. User Flow
1. Open the **Upscale** tab in the Properties panel (tab strip: Background | Enhance | Shadow | **Upscale** | Text Removal). A Home sidebar entry **Image Upscaler** opens the editor on this tab.
2. If the model for the chosen scale is missing, the `ModelInstallBanner` shows **Install now** (for example "Upscaler x4, about 65 MB").
3. Choose scale and options, review the estimate (output size, time, memory), and click **Upscale**.
4. Compare with the Before/After slider (and a 100% zoom detail view), then **Keep** or **Discard**.
5. The upscaled image replaces the working image in the pipeline, and export uses the new size.

---

## 3. UI Specification (warm terracotta style)

### 3.1 Properties panel: Upscale tab
```
Upscale
[ Model banner when missing ]
Scale     ( 2x )  ( 4x )  ( Custom target size )
Target    [ W ] x [ H ]  [lock]     (shown for Custom)
Model     (o) General photo   ( ) Illustration / anime   (shown if installed)
Quality   (o) Balanced   ( ) Best (more overlap, slower)
Options
 [ x ] Process transparency separately (clean cut-out edges)
 [ x ] Reduce artefacts (light denoise before upscaling)
Estimate
 Input 800 x 600  ->  Output 3200 x 2400 (7.7 MP)
 About 12 s on CPU   |   Memory about 1.2 GB
 [ ! warning if the output exceeds the size cap ]
[ Upscale ]   (primary)
```
- Result view: Before/After slider with a **Detail loupe** (100% crop follows the cursor) to judge quality.
- Progress overlay with percentage, tile counter, **Cancel**; status bar shows "Upscaling...".
- Output size cap setting (default 100 MP, configurable) with a clear message when exceeded.

### 3.2 Required states
Model missing, estimate warning (memory or size), processing, cancelled, result review (Keep/Discard), error with Retry, already-large image notice ("This image is already high resolution. Upscale anyway?").

---

## 4. Rust Pipeline

### 4.1 Models (from Model Hub)
- `upscale-x2` and `upscale-x4` (Real-ESRGAN-class, ONNX), optional `upscale-x4-anime`.
- **Custom target size:** run the nearest model scale (2x or 4x) that reaches or exceeds the target, then resize down to the exact target with Lanczos3.
- Execution providers follow Settings > Model (CPU, or GPU if available with fallback).

### 4.2 Tiled inference
- Convert to RGB f32 NCHW in `[0,1]` (or per `runtime` in the manifest).
- Split into tiles (default 256 px input tiles; auto-reduce on low memory) with **overlap** (default 16 to 32 px).
- Infer each tile, then **blend overlaps** with a feathered (cosine or linear) weight window to avoid seams; discard the overlap border where possible.
- Reflect-pad image borders so edge tiles do not show artefacts.
- Dynamic memory guard: estimate peak memory before starting; if too high, reduce tile size automatically and tell the user.
- Run on `spawn_blocking`, report progress per tile, support cancel at tile boundaries and free buffers promptly.
- **Output assembly:** write directly into the destination buffer tile by tile to avoid holding duplicate full-size buffers.

### 4.3 Transparency handling
- If the image has alpha (for example a cut-out from background removal): upscale **colour** (premultiplied-to-straight corrected) with the model and upscale **alpha** separately with a high-quality edge-aware resize (Lanczos plus a light threshold-and-feather clean-up) so edges stay crisp and halo-free.
- When the user upscales **before** background removal, keep the existing alpha mask pipeline consistent: the final mask is resized to the new resolution using the same edge-aware resize.
- Pipeline order: Text Removal, Enhance, **Upscale**, cut-out mask, Shadow, Background, Export. Shadow and brush edits scale accordingly (parameters in px are stored relative to the image size or rescaled on change).

### 4.4 Fallback and light denoise
- **No-model fallback:** Lanczos3 plus mild unsharp mask, clearly labelled "Standard (no AI)". It is available without installing any model.
- Optional pre-denoise ("Reduce artefacts") uses a fast classical denoise to reduce JPEG blocking before the model sees the image.

### 4.5 Data model
- Store the result as a derived asset `images/<id>/upscaled_<scale>.png` plus params in `state.json` (`{scale, model, version, options}`). Option to **discard** and revert to the original at any time.
- Bump `formatVersion` with a migration (older projects have no upscale). Autosave includes it.

---

## 5. IPC Contract
| Command | Input | Output |
|---|---|---|
| `upscale_estimate` | `imageId`, `{scale or target}` | `{outW, outH, megapixels, etaSeconds, memoryMb, warnings[]}` |
| `upscale_run` | `imageId`, `{scale, modelId, quality, alphaSeparate, preDenoise}` | `jobId` (progress by events) |
| `upscale_accept` / `upscale_discard` | `imageId` | void |
| `upscale_batch` | `imageIds[]`, `params` | `jobId` |
| `upscale_requirements` | `scale` | `{ready, missing}` (Model Hub) |

Missing model returns `AppError::ModelMissing {id}`. Events: `job:progress {done, total, tile}`, `job:item-complete`, `job:error`.

**Batch:** upscale many images with the same settings through the batch dialog; failures do not stop the batch; per-item review is optional after completion.

---

## 6. Performance, Edge Cases, Security
- Targets (CPU, balanced): 1 MP image to 4x in about 20 to 40 s; faster with GPU; memory stays within the estimate; UI never freezes; cancel responds within one tile.
- Edge cases: 16-bit and CMYK inputs (convert to sRGB 8-bit with a notice), very small inputs (below 64 px), extreme aspect ratios, images with embedded colour profiles (convert and preserve the profile on export when possible), huge outputs (block with explanation), transparent PNGs, animated GIFs (first frame).
- Honesty note in the UI: AI upscaling adds plausible detail and may alter fine textures or text; it is not a substitute for a high-resolution original.
- Security and privacy: no network use in this feature; validate sizes and limits in Rust.

---

## 7. Phases and Acceptance Criteria
After each phase: lint, type-check, tests, smoke test, short report, stop for approval.

### Phase U0: UI shell, estimate and classical fallback
**Build:** Upscale tab, Home sidebar entry, scale and target controls, estimate calculation, model banner wiring, Lanczos plus unsharp fallback, Before/After and detail loupe, Keep/Discard, project storage and migration.
**Acceptance:** the fallback upscales and previews correctly; the estimate matches actual output size; Keep/Discard works and persists.

### Phase U1: AI upscaling with tiling
**Build:** model session via Model Hub, tiled inference with overlap blending, border padding, progress, cancel, memory guard, custom target size via model scale plus resize.
**Acceptance:** no visible seams on test images; a 2 MP input to 4x completes without exceeding the estimated memory; cancel is immediate at tile boundaries; the UI stays responsive.

### Phase U2: Transparency, options and pipeline integration
**Build:** separate alpha processing, optional pre-denoise, anime model option, interaction with brush edits, shadow and export sizes, History entries.
**Acceptance:** cut-outs upscale without halos; export dimensions equal the upscaled size; the full pipeline (remove BG, upscale, shadow, export) produces correct output.

### Phase U3: Batch and polish
**Build:** batch upscaling via the job queue, GPU provider with fallback, size cap setting, large-image warnings, Dark theme and accessibility checks.
**Acceptance:** a 30-image batch completes with per-item status; failures are isolated; targets in section 6 are met.

### Phase U4: Tests
**Build:** Rust tests (tile layout and overlap weights, blending continuity, padding, scale and target maths, alpha handling), golden-image tolerance tests, frontend tests for all states, end-to-end (install model, upscale, review, keep, save, export).
**Acceptance:** all tests green on CI; works fully offline after install.

---

## 8. Start Instruction
Begin with **Phase U0 only**. Post a short plan, implement, then stop and report. Do not start Phase U1 until explicitly approved.
