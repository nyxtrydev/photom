# PHOTOM Feature 1: Text Removal (Text and Watermark Removal for the User's Own Images)

> Prerequisite: **Feature 0 (Model Hub)** is implemented. Paste this into your coding tool as a new task on the existing Photom codebase. Work phase by phase and stop for approval after each phase.

---

## 0. Working Rules
1. Extend the existing architecture (Tauri 2, React + TypeScript, Rust, ONNX Runtime, `JobQueue`, `.photom` project format, undo/redo, Zustand, design tokens, Model Hub). Do not rewrite working code.
2. Fully offline after the models are installed. No image data leaves the device.
3. All models come from the Model Hub with the **Install now** flow. This feature never downloads anything itself.
4. Edits are **non-destructive** and stored in the project; the original image is never modified.
5. Small conventional commits, tests alongside code, decisions in `docs/DECISIONS.md`. Stop after each phase for approval.

---

## 1. Purpose and Responsible Use
Remove unwanted text, captions, date stamps, logos and watermarks from images **the user owns or has permission to edit** (their own photos, their own product shots, their own brand assets).

Required safeguards:
- A one-time confirmation dialog the first time the tool is used: *"Use this tool only on images you own or have permission to edit."* with **I understand** and **Cancel**. Store the acknowledgement in settings.
- A short note in Settings > About describing the intended use.
- The tool must **not** strip or alter embedded metadata, provenance or content-credential data (EXIF, XMP, C2PA). Pass such metadata through unchanged where the export format supports it.
- No automatic "remove watermark" in bulk without the same acknowledgement; batch mode requires it too.

---

## 2. User Flow
1. In the editor, open the **Text Removal** tab in the Properties panel (tab strip: Background | Enhance | Shadow | Upscale | **Text Removal**). A Home sidebar entry **Text Removal** opens the editor on this tab.
2. If models are missing, the `ModelInstallBanner` (Feature 0) shows **Install now** for `text-detector` and `inpaint-lama`. Controls stay disabled until ready.
3. Choose how to select what to remove:
   - **Auto-detect text:** the detector proposes text regions as overlays the user can click to include or exclude.
   - **Brush:** paint over any mark (reuses the existing brush engine, size and hardness).
   - **Rectangle / Lasso:** drag a selection.
4. Adjust **Expand selection** (mask dilation in px) so the selection covers soft edges and shadows.
5. Click **Remove**. A preview appears with the Before/After slider. Accept, adjust or undo.
6. Repeat for other areas. Everything stacks as undoable steps.

---

## 3. UI Specification (warm terracotta style)

### 3.1 Properties panel: Text Removal tab
```
Text Removal
[ Model banner when missing ]
Select
 ( Auto-detect )  ( Brush )  ( Rectangle )  ( Lasso )
 [ Detect text ]   Sensitivity  --o--
Selection
 Expand        --o--  8 px
 Feather       -o---  2 px
 [ Clear selection ]  [ Invert ]
Quality
 (o) Fast   ( ) Best (tiled, slower)
 [ x ] Keep original grain / noise match
[ Remove ]   (primary button)
```
- Detected regions are drawn as dashed terracotta boxes with a small checkbox; hover highlights.
- A progress overlay on the canvas with a **Cancel** button; the status bar shows "Removing text...".
- Brush cursor and zoom/pan reuse existing canvas tools. Add tool-rail entries only while this tab is active.

### 3.2 Required states
Empty selection (button disabled with hint), model missing, detection found nothing ("No text found. Try the brush."), processing, result applied, error (with Retry), and the one-time ownership confirmation dialog.

---

## 4. Rust Pipeline

### 4.1 Text detection
- Model: `text-detector` (DBNet or CRAFT class) via ONNX Runtime.
- Preprocess: resize with aspect ratio preserved to a multiple of 32 (long side capped, e.g. 1280), normalise per `runtime` in the manifest.
- Postprocess: threshold the probability map, find contours, unclip/expand polygons, scale back to original coordinates, return polygons plus confidence.
- Output: list of `{id, polygon, confidence}`; the rasterised union becomes the selection mask (8-bit).

### 4.2 Inpainting
- Model: `inpaint-lama` (LaMa class, ONNX), fixed input size (typically 512x512) with image and mask inputs.
- **Tiled strategy for large images:** for each connected mask region, crop a context window around its bounding box (padding about 2x region size, minimum 512 px), resize to the model input, infer, resize back, and **blend only inside the dilated mask** using a feathered alpha. This keeps cost proportional to the selection, not the image size.
- Large regions: split into overlapping tiles processed in sequence, composited with feathered seams.
- Preserve full resolution: only the masked area is replaced; the rest of the original pixels are untouched.
- Optional **grain match:** estimate local noise in the surrounding area and add matching noise to the inpainted patch so the fix does not look smooth.
- Run on `spawn_blocking`, report progress per region through the job queue, honour cancel.

### 4.3 Data model (non-destructive)
- Store each removal step as a **patch**: `{id, maskPng, bbox, patchPng (RGBA of the replaced region), params, createdAt}` in the project, per image.
- The render pipeline applies patches in order over the original: **Text Removal is stage 1** of the image pipeline (before Enhance, Upscale, background removal, Shadow and Export).
- Undo/redo uses command objects referencing patches; memory is bounded by storing only the bounding-box patch, not full images.

---

## 5. IPC Contract
| Command | Input | Output |
|---|---|---|
| `text_detect` | `imageId`, `{sensitivity}` | `{regions: [{id, polygon, confidence}]}` |
| `text_remove` | `imageId`, `maskRef` (or polygons plus strokes), `{expand, feather, quality, grainMatch}` | `{patchId, bbox, previewPath}` |
| `text_remove_batch` | `imageIds[]`, `{autoDetect: true, params}` | `jobId` |
| `text_patch_delete` | `imageId`, `patchId` | void |
| `text_requirements` | none | `{ready, missing}` (uses Model Hub) |

**Events:** `job:progress`, `job:item-complete`, `job:error`. Missing models return `AppError::ModelMissing {id}` so the UI shows the install banner.

**Batch mode:** auto-detect plus remove for many images with the same parameters, via the existing batch dialog; each image's result is stored as a patch so it can still be reviewed and undone individually.

---

## 6. Project Format and Migration
- Bump the `.photom` `formatVersion`; add `images/<id>/patches/*.png` and a `patches` array in `state.json`.
- Provide a **migration** for older projects (no patches) and tests that open a previous-version project unchanged.
- Autosave must include patches.

---

## 7. Performance, Edge Cases and Security
- Targets: auto-detect under 2 s on a 12 MP image (CPU); inpaint of a small watermark region under 3 s; memory bounded by region windows.
- Edge cases: text touching image borders, semi-transparent watermarks, tiled/repeating watermarks across the whole image (offer **Process in sections** and warn quality may vary), very large selections (warn and suggest sections), images with alpha, 16-bit and CMYK inputs.
- Security: no network use in this feature; validate image and mask sizes received over IPC; cap region count and area to prevent memory exhaustion.

---

## 8. Phases and Acceptance Criteria
After each phase: lint, type-check, tests, smoke test, short report, stop for approval.

### Phase T0: Scaffolding, consent and UI shell
**Build:** Text Removal tab and Home sidebar entry; one-time ownership dialog and setting; model requirement hook wired to the install banner; selection tools (brush, rectangle, lasso) producing a mask; Expand and Feather controls.
**Acceptance:** with models missing, the banner appears and **Install now** works; the consent dialog appears once; selections render correctly at all zoom levels.

### Phase T1: Text detection
**Build:** `text_detect` pipeline, region overlays with include/exclude toggles, sensitivity control, "No text found" state.
**Acceptance:** printed text, date stamps and logos on test images are detected; toggling regions updates the mask; detection stays responsive on a 12 MP image.

### Phase T2: Inpainting and patches
**Build:** `text_remove` with the tiled strategy, feathered blending, grain match, patch storage, preview with Before/After, undo/redo, cancel.
**Acceptance:** results show no visible seams on test images; pixels outside the mask are bit-identical to the original; undo and redo restore exact states.

### Phase T3: Project integration and batch
**Build:** `.photom` migration, autosave and reopen, pipeline ordering with other stages, batch removal through the job queue with the acknowledgement requirement, History entries.
**Acceptance:** save, close and reopen preserves patches; a 20-image batch completes with per-item status; old projects open without error.

### Phase T4: Tests and polish
**Build:** Rust tests (mask dilation, tiling and blending math, bbox maths, patch round-trip), frontend tests (tool states, banner states), end-to-end (install model, detect, remove, undo, save); accessibility and keyboard shortcuts (`T` tab, `[` `]` brush size); Dark theme check.
**Acceptance:** all tests pass; no console errors; works fully offline after install.

---

## 9. Start Instruction
Begin with **Phase T0 only**. Post a short plan, implement, then stop and report. Do not start Phase T1 until explicitly approved.
