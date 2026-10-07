# PHOTOM Feature 2: Shadow Generator (Realistic Shadows After Background Removal)

> Prerequisite: the core Photom app. **No AI model is needed**, so this feature has no Model Hub dependency and can be built immediately. Paste this into your coding tool as a new task on the existing codebase. Work phase by phase and stop for approval after each phase.

---

## 0. Working Rules
1. Extend the existing architecture (Tauri 2, React + TypeScript, Rust, canvas editor, `.photom` projects, undo/redo, batch job queue, export dialog, design tokens). Do not rewrite working code.
2. Fully offline and procedural: the shadow is computed from the subject's alpha mask.
3. Non-destructive: shadow parameters are stored in the project; the cut-out is never modified.
4. Small conventional commits, tests alongside code, decisions in `docs/DECISIONS.md`. Stop after each phase for approval.

---

## 1. Purpose
After background removal, give the subject a realistic shadow so it looks naturally placed on a surface (essential for e-commerce and product images). The shadow is generated from the subject's alpha mask, composited under the subject, and exported on a transparent or chosen background.

---

## 2. Shadow Types
1. **Drop shadow:** soft offset shadow behind the subject (angle, distance, blur, opacity, colour).
2. **Contact shadow:** a tight, dark, soft shadow where the subject touches the ground, fading quickly with distance.
3. **Cast shadow (long shadow):** the mask is projected along a light direction onto the floor plane, with perspective squash and a length falloff.
4. **Reflection (optional):** a vertically flipped, faded, slightly blurred copy of the subject beneath it, with a gradient fade and adjustable gap.

Types can be **combined** (for example contact plus cast) as stackable layers, each with its own parameters and visibility toggle.

---

## 3. UI Specification (warm terracotta style)

### 3.1 Properties panel: Shadow tab
```
Shadow     [ x ] Enable
Preset: ( Product ) ( Floating ) ( Grounded ) ( Soft studio ) ( Custom )
Layers   [ + Add layer v ]
 > Drop shadow            [eye] [trash]
     Angle       --o--   135 deg
     Distance    -o---   24 px
     Blur        --o--   32 px
     Spread      -o---   0
     Opacity     --o--   45 %
     Colour      [ ## ]  (default warm black)
 > Contact shadow         [eye] [trash]
     Size / Softness / Opacity / Ground offset
 > Cast shadow            [eye] [trash]
     Light angle / Elevation / Length / Squash / Falloff / Blur growth / Opacity
 > Reflection             [eye] [trash]
     Gap / Fade length / Opacity / Blur
Ground
 [ x ] Show ground line guide   Ground Y  -o--
[ Reset ]   [ Apply to all images ]
```
- Live preview in the canvas with a **Shadow only** debug toggle (shows the shadow on a neutral background).
- A draggable **light direction handle** and **ground line handle** on the canvas for direct manipulation.
- Colour picker reuses the existing component (hex, recent colours).
- Presets are saved as named presets in settings (create, rename, delete). Four built-in presets are provided with sensible values.

### 3.2 Required states
Shadow disabled, no cut-out yet (hint: "Remove the background first", with a **Remove BG** shortcut), processing on large images, apply-to-all progress, invalid parameter clamping.

---

## 4. Rendering Pipeline

### 4.1 Where it sits
Image pipeline order: Text Removal, Enhance, Upscale, cut-out mask, **Shadow**, Background, Export. Shadow reads the **final subject alpha** (after refine and brush edits) and the final output size.

### 4.2 Algorithms (Rust; also mirrored in a fast canvas preview)
- **Canvas expansion:** the output canvas may need extra margin so shadows are not clipped. Compute the combined shadow bounds and add padding automatically; expose a **Auto expand canvas** toggle (on by default) and apply the same bounds on export.
- **Drop shadow:** take the alpha mask, tint with the shadow colour, translate by `(dx, dy)` from angle and distance, apply Gaussian blur (separable, `fast_image_resize` or a custom box-blur approximation for speed), scale by opacity. Optional spread via dilate before blur.
- **Contact shadow:** take the bottom band of the mask (a height fraction around the ground line), flatten it vertically (squash), blur with a small radius and increased opacity, and fade by distance from the ground.
- **Cast shadow:** apply an affine/projective transform to the mask based on light angle and elevation (shear plus vertical squash) anchored on the ground line; apply a **linear falloff** of opacity along the shadow length and **blur that grows with distance** (render at several blur levels and blend by distance).
- **Reflection:** flip vertically about the ground line, offset by the gap, multiply by a linear gradient alpha, apply a light blur.
- **Blending:** composite each layer in order under the subject with premultiplied-alpha maths to avoid dark fringes; use 8-bit with linear-light option (setting) for accuracy; clamp and dither lightly to prevent banding in soft gradients.
- **Ground line detection (default):** use the lowest subject pixels (alpha above a threshold) as the default ground line, with a manual override.
- Use `rayon` for parallel blur; process at a downscaled proxy for interactive preview (target 60 fps on slider drag) and at full resolution on export.

### 4.3 Data model
Per image in `state.json`:
```json
"shadow": {
  "enabled": true,
  "autoExpand": true,
  "groundY": 0.92,
  "layers": [
    { "type": "drop", "visible": true, "angle": 135, "distance": 24, "blur": 32, "spread": 0, "opacity": 0.45, "color": "#2b1a10" },
    { "type": "contact", "visible": true, "...": "..." }
  ],
  "presetId": "product"
}
```
Bump `formatVersion` with a migration (older projects get `shadow: null`). Autosave includes it.

---

## 5. IPC Contract
| Command | Input | Output |
|---|---|---|
| `shadow_preview` | `imageId`, `ShadowParams`, `proxySize` | preview image path or binary |
| `shadow_render` | `imageId`, `ShadowParams` | full-resolution RGBA path and new canvas bounds |
| `shadow_apply_batch` | `imageIds[]`, `ShadowParams or presetId` | `jobId` |
| `shadow_presets_list` / `save` / `delete` | preset | presets |

Export (Phase 4 of the base app) must call the shadow renderer when enabled, and the **Export dialog** gains the line "Include shadow" (default on) and an option **Shadow on separate layer** (exports `name-photom-shadow.png` alongside) for designers.

Undo/redo: every slider change coalesces into one undo step per drag; layer add/remove/reorder are separate steps.

---

## 6. Performance, Edge Cases, Security
- Targets: preview update under 50 ms on a 2 MP proxy; full render of a 12 MP image under 2 s.
- Edge cases: very thin or semi-transparent subjects, subjects touching the canvas edge (auto-expand), subjects with holes (handles correctly via alpha), solid-colour backgrounds where shadow colour must stay visible, Dark theme canvas preview accuracy, extreme blur values (clamp), animated GIF inputs (use first frame).
- Security and privacy: no network use; validate parameter ranges in Rust.

---

## 7. Phases and Acceptance Criteria
After each phase: lint, type-check, tests, smoke test, short report, stop for approval.

### Phase S0: Parameters, UI shell and drop shadow
**Build:** Shadow tab, data model, enable toggle, drop shadow layer with live canvas preview, auto canvas expansion, undo/redo, project save and migration.
**Acceptance:** dragging sliders updates the preview smoothly; shadow not clipped; save and reopen preserves settings; old projects open fine.

### Phase S1: Contact and cast shadows
**Build:** ground line detection and handle, contact shadow, cast shadow with falloff and growing blur, light direction handle, layer stacking and reordering.
**Acceptance:** results look natural on test products (bottle, shoe, chair); ground handle repositions the shadows correctly; layers combine without artefacts.

### Phase S2: Reflection, presets and export
**Build:** reflection layer, built-in and custom presets, Export dialog integration ("Include shadow", "Shadow on separate layer"), full-resolution render path, "Shadow only" debug view.
**Acceptance:** exported PNG matches the preview at full resolution; separate shadow layer exports correctly; presets persist.

### Phase S3: Batch and polish
**Build:** Apply to all images via the job queue with progress, History entries, performance profiling with `rayon`, linear-light option, banding dither, Dark theme and accessibility checks.
**Acceptance:** a 40-image batch applies a preset consistently; targets in section 6 met; no console errors.

### Phase S4: Tests
**Build:** Rust unit tests (offset maths, blur normalisation, projection transform, premultiplied compositing, bounds calculation), golden-image tests with tolerance, frontend tests, end-to-end (remove BG, add shadow, export, compare).
**Acceptance:** all tests pass on CI.

---

## 8. Start Instruction
Begin with **Phase S0 only**. Post a short plan, implement, then stop and report. Do not start Phase S1 until explicitly approved.
