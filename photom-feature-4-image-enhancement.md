# PHOTOM Feature 4: Image Enhancement (Fix Blur, Noise, Exposure and Sharpness)

> The core tools in this feature are classical image processing and need **no AI model**. One optional tool (AI denoise) uses the **Model Hub (Feature 0)** with the **Install now** flow. Paste this into your coding tool as a new task on the existing Photom codebase. Work phase by phase and stop for approval after each phase.

---

## 0. Working Rules
1. Extend the existing architecture (Tauri 2, React + TypeScript, Rust, canvas editor, `.photom` projects, undo/redo, batch job queue, export dialog, design tokens, Model Hub). Do not rewrite working code.
2. Fully offline. No image data leaves the device.
3. Non-destructive: enhancement settings are stored as parameters; the original is never modified.
4. Small conventional commits, tests alongside code, decisions in `docs/DECISIONS.md`. Stop after each phase for approval.

---

## 1. Purpose
Let users quickly fix common photo problems: exposure and colour, noise, softness and blur, with an **Auto Enhance** one-click option and precise manual controls, with real-time preview.

---

## 2. Tools

### 2.1 Auto Enhance (one click)
- Analyse the histogram and channel statistics, then set: exposure correction, contrast (levels stretch with clipping limits of about 0.5%), shadow and highlight recovery, white balance (gray-world or highlight-based estimate, conservative), vibrance, and mild sharpening.
- Show the resulting slider values so the user can fine-tune. **Reset** restores defaults. A strength slider (0 to 100%) blends between original and auto result.

### 2.2 Light and Colour
Exposure (EV), Contrast, Highlights, Shadows, Whites, Blacks, Temperature, Tint, Vibrance, Saturation. Implemented in linear-light where appropriate, with smooth curves to avoid banding and clipping. A live **histogram** with clipping warnings.

### 2.3 Noise Reduction
- **Classical (default):** edge-preserving denoise (bilateral filter or non-local means, optimised), separate **Luminance** and **Colour** strength sliders plus a Detail preservation slider.
- **AI Denoise (optional model):** `denoise-ai` from the Model Hub, tiled like the upscaler. The `ModelInstallBanner` shows **Install now** only when the user selects this mode.

### 2.4 Sharpening
- **Unsharp mask:** Amount, Radius, Threshold.
- **Edge-aware sharpen (default):** sharpen luminance only, with a masking slider so flat areas and noise are not amplified, plus halo suppression.

### 2.5 Deblur (light)
- Deconvolution-based **Deblur** (Richardson-Lucy or Wiener) for mild out-of-focus or small motion blur, with Strength and Radius controls and an automatic regularisation to limit ringing.
- Clear note in the UI: *"Works best on mild blur. Heavy motion or focus blur cannot be fully recovered."*
- Optional **blur check**: compute a sharpness score (variance of Laplacian) and tell the user when the image looks soft.

### 2.6 Subject-aware option
When a cut-out mask exists, offer **Apply to: Whole image / Subject only / Background only**, using the alpha mask with soft edges.

---

## 3. UI Specification (warm terracotta style)

### 3.1 Properties panel: Enhance tab
```
Enhance            [ Auto Enhance ]   strength --o-- 70%
Histogram  [ graph with clip warnings ]
> Light & Colour
    Exposure  Contrast  Highlights  Shadows  Whites  Blacks
    Temperature  Tint  Vibrance  Saturation
> Noise Reduction
    Mode ( Standard ) ( AI Denoise )   [ model banner if AI missing ]
    Luminance  Colour  Detail
> Sharpen
    Mode ( Edge-aware ) ( Unsharp )   Amount  Radius  Threshold  Masking
> Deblur
    Strength  Radius      [ info note ]  Sharpness score: 38 (soft)
Apply to ( Whole image ) ( Subject only ) ( Background only )
[ Reset section ]  [ Reset all ]  [ Copy settings ] [ Paste settings ]
```
- Each section collapsible with an enable checkbox; every slider has a numeric field and double-click to reset.
- **Before/After** toggle and split view reuse the existing slider; hold a key (`\`) to temporarily show the original.
- Live preview at 60 fps on slider drag using a downscaled proxy; full-quality render settles after the drag stops. A small "Rendering..." indicator shows while the full-quality pass runs.

### 3.2 Required states
No image, AI model missing (banner), processing on full resolution, clipping warnings, copy/paste settings feedback toast, error with Retry.

---

## 4. Rendering Pipeline

### 4.1 Order of operations (within Enhance)
`Noise reduction → Deblur → Light and Colour → Sharpen` (sharpening last so it is not amplified by earlier steps). In the whole image pipeline: Text Removal, **Enhance**, Upscale, cut-out mask, Shadow, Background, Export. If the user upscales, offer a hint to enhance first.

### 4.2 Implementation notes (Rust)
- Convert to linear-light f32 working space for tonal and colour operations; convert back with correct gamma. Preserve the embedded colour profile where possible (convert to sRGB with a notice otherwise).
- Use `rayon` for parallelism; process in tiles for the heavy filters (non-local means, deconvolution) to bound memory; SIMD-friendly loops; cache the denoised intermediate when only later stages change.
- **Preview path:** a downscaled proxy (for example 1.5x the viewport size) processed on each change; **full path** runs on export or when the user clicks Apply, using identical parameters so the preview matches the export within tolerance.
- AI denoise: tiled inference with overlap blending (same approach as the upscaler), via `session_cache::get("denoise-ai")`; missing model returns `AppError::ModelMissing`.
- Dither lightly when converting back to 8-bit to avoid banding in gradients.

### 4.3 Data model
Per image in `state.json`:
```json
"enhance": {
  "enabled": true,
  "scope": "whole",
  "light": { "exposure": 0.0, "contrast": 0, "highlights": 0, "shadows": 0, "whites": 0, "blacks": 0, "temperature": 0, "tint": 0, "vibrance": 0, "saturation": 0 },
  "noise": { "mode": "standard", "luma": 0, "chroma": 0, "detail": 50 },
  "sharpen": { "mode": "edge", "amount": 0, "radius": 1.0, "threshold": 0, "masking": 0 },
  "deblur": { "strength": 0, "radius": 1.0 }
}
```
Bump `formatVersion` with a migration (older projects get `enhance: null`). Autosave includes it. Undo/redo coalesces a slider drag into one step.

---

## 5. IPC Contract
| Command | Input | Output |
|---|---|---|
| `enhance_analyze` | `imageId` | `{histogram, sharpnessScore, suggestedAuto: EnhanceParams}` |
| `enhance_preview` | `imageId`, `EnhanceParams`, `proxySize` | preview image (binary or path) |
| `enhance_render` | `imageId`, `EnhanceParams` | full-resolution result path |
| `enhance_apply_batch` | `imageIds[]`, `EnhanceParams or preset` | `jobId` |
| `enhance_presets_list` / `save` / `delete` | preset | presets |
| `enhance_requirements` | `{aiDenoise: bool}` | `{ready, missing}` (Model Hub) |

Export integrates enhancement automatically. The batch dialog supports **Auto Enhance all** and applying copied settings to many images. Settings can be saved as named presets (for example "Product clean", "Low-light fix").

---

## 6. Performance, Edge Cases, Security
- Targets: slider-drag preview under 33 ms on the proxy; full-resolution render of a 12 MP image (standard denoise plus sharpen) under 4 s on a typical laptop CPU; memory bounded by tiling.
- Edge cases: already-clipped images (limit boosts and warn), grayscale and 16-bit inputs, images with alpha (process colour, keep alpha), very noisy low-light images (cap strengths to prevent plastic look), extreme settings (clamp and warn), CMYK conversion.
- Security and privacy: no network use except the optional model download through the Model Hub; validate parameter ranges in Rust.

---

## 7. Phases and Acceptance Criteria
After each phase: lint, type-check, tests, smoke test, short report, stop for approval.

### Phase E0: Panel shell, histogram and Light and Colour
**Build:** Enhance tab, data model, linear-light pipeline, Light and Colour controls, histogram with clipping warnings, proxy preview, before/after toggle, reset and copy/paste settings, project save and migration, undo/redo.
**Acceptance:** slider drags stay smooth; preview matches a full render within tolerance; save, reopen and migration work.

### Phase E1: Sharpen and Noise Reduction (classical)
**Build:** edge-aware and unsharp sharpening, luminance/colour denoise with detail preservation, tiled processing, intermediate caching, scope (whole, subject, background) using the mask.
**Acceptance:** noise is reduced without waxy artefacts on test images; sharpening shows no halos at default settings; subject-only mode has soft, clean edges.

### Phase E2: Auto Enhance, deblur and presets
**Build:** `enhance_analyze`, Auto Enhance with strength blend, sharpness score, deconvolution deblur with ringing control, presets (built-in and custom), Export integration, History entries.
**Acceptance:** Auto Enhance improves a set of under-exposed, over-exposed and low-contrast test photos without clipping; deblur improves mild blur without obvious ringing.

### Phase E3: AI Denoise (optional) and batch
**Build:** AI denoise mode wired to the Model Hub banner (**Install now**), tiled inference with overlap blending, batch enhancement via the job queue (Auto Enhance all, apply copied settings), GPU provider with fallback, Dark theme and accessibility checks.
**Acceptance:** with the model missing, only the AI mode is gated and everything else works; after install the AI mode works offline; a 30-image batch completes with per-item status.

### Phase E4: Tests
**Build:** Rust unit tests (tone curves, white balance, histogram and statistics, sharpen kernels, denoise invariants, deconvolution stability, tile blending, colour-space conversions), golden-image tolerance tests, frontend tests, end-to-end (import, auto enhance, adjust, export, compare).
**Acceptance:** all tests pass on CI; preview and export parity verified.

---

## 8. Start Instruction
Begin with **Phase E0 only**. Post a short plan, implement, then stop and report. Do not start Phase E1 until explicitly approved.
