# Decisions

1. **Tailwind v3** (not v4): stable config-driven token mapping.
2. **Fonts** via `@fontsource-variable/inter` and `/fraunces`, bundled by Vite, no remote loading.
3. **`--text-muted` darkened** to `#7A6757` (spec `#8A7767`) to meet WCAG AA on `--bg-app`.
4. **Extra `AppError` variants** `InvalidInput` and `Internal` beyond the spec list, for validation and unexpected failures.
5. **Plugins in Phase 0:** window-state, single-instance, store, dialog, fs, os. `updater` deferred to Phase 6 (needs signing keys; opt-in); `clipboard-manager` to Phase 4.
6. **Heavy crates deferred** (`ort`, `image`, `rayon`, ...) to the phase that uses them, to keep Phase 0 builds fast.
7. **Theme persistence** uses `localStorage` until the settings store lands (Phase 3).
8. **Title bar** is the same component across screens; the mockup editor menu bar slots in via `children`.
9. **Icons** generated from `docs/design/logo-source.png` with `tauri icon`; mobile icon sets removed (non-goal).
10. **Dev port 1430** (Tauri default 1420 clashes with other local Vite projects).
11. **`import_images` returns `{ images, rejected }`** instead of a bare `ImageMeta[]`, so one bad file never fails a whole import and the UI can explain each rejection.
12. **Fast model = ISNet general-use (Apache-2.0) with float16-stored weights, 90.6 MB** (the float32 original is 178.6 MB, over the 150 MB installer target). `scripts/make-fast-model.py` stores each large weight tensor as fp16 and adds a Cast back to fp32, so inference still runs in fp32: on the test photo the masks are identical (IoU 1.0000, mean difference 0.001/255) at the same speed. Photom prefers `isnet-general-use-fp16.onnx` and falls back to the fp32 file for developers; both are checksum-verified. Neither file is committed; `npm run model:fetch` downloads the fp32 file and builds the fp16 one when Python with `onnx` is available. Release builds must bundle only the fp16 file (Phase 6).
13. **`ort` 2.0.0-rc.13**, pinned. Windows/Linux/Apple Silicon use downloaded binaries. **Intel macOS has no prebuilt ONNX Runtime**, so it uses `load-dynamic` with a runtime 1.22.0 dylib in `src-tauri/vendor/` (dev only, git-ignored). Default graph-optimisation level is used because `Level3` needs a newer runtime.
14. **CUDA** is not wired yet (needs the `cuda` feature and separate binaries); DirectML covers Windows GPUs, CoreML covers Apple Silicon. Revisit in Phase 5.
15. **Mask transport** is a PNG file in the app cache dir (path returned over IPC), per Section 3.3.
16. **Dev profile** compiles dependencies at opt-level 3 and our crate at 1; image work is unusably slow otherwise.
17. **Hero illustration** is cropped from the mockup as a placeholder; replace `src/assets/illustrations/hero.png` with final art.
18. **CMYK TIFF** is not supported by the `image` crate; it is rejected with a Decode message. Revisit in Phase 5.
19. **Refine/edit maths runs in the frontend for preview** (`canvas/maskOps.ts`), not via `refine_mask`/`apply_mask_edit`/`compose_preview` IPC round-trips, to meet the 200 ms / 60 fps targets. The Rust exporter (Phase 4) re-implements the same maths at full resolution; the shared definitions are documented in `maskOps.ts` and covered by tests on both sides.
20. **Working size 2048**, not 2560: measured refine cost at 2560x1920 was ~140-260 ms on an Intel laptop CPU; 2048 keeps the default refine under the 200 ms target.
21. **Slider units** are source pixels (feather 0..20, edge shift -20..20, brush size 1..150) and scale with the working ratio.
22. **Plain wheel pans, Ctrl/Cmd+wheel zooms** (trackpad-friendly; pinch arrives as Ctrl+wheel).
23. **Home import opens the editor** with the first imported image; the interim "imported images" card list from Phase 1 was removed.
24. **Dev-only `window.__photom`** exposes stores to Playwright tests; it is compiled out of production builds (`import.meta.env.DEV`).
25. **Brush edits are stored as strokes in `state.json`**; no `mask_edits.png` in format v1 (strokes are authoritative and resolution-independent).
26. **Autosave links originals** instead of embedding them (fast, small), except originals that live in the app cache, which are embedded because the cache is not a stable location.
27. **Restored work is "unsaved"** and tied to the original path; Save overwrites the user's file only when the user asks. Opening a `.bak` after corruption never adopts the damaged file's path.
28. **Settings live in the backend** (Rust validates/migrates; the frontend mirrors). Theme is applied from `localStorage`-free settings after load; first paint uses the system theme.
29. **`window-state` plugin owns window geometry**, so `windowState` is not duplicated in `settings.json`.
30. **Model import** validates the file by creating an ONNX session, copies it atomically into `<app data>/models`, and verifies the checksum when the slot has a known hash. Nothing is ever downloaded by the app.
31. **Update check** button is present but disabled until the signed, opt-in updater ships in Phase 6.
32. **Export size semantics:** "Original" = size after the optional crop (never upscaled); "Custom" = exact W x H applied after cropping; presets may add a `maxSide` cap (Web = 2000 px).
33. **Crop box** uses mask values >= 10, so a feathered edge's faint halo counts as subject; the padding is exact relative to that box.
34. **Images without a cut-out** fail individually with a clear message instead of blocking a batch.
35. **Job events are triggers, snapshots are truth** (see ARCHITECTURE); this removes races between `export_png` returning the job id and the first events.
36. **Batch removal concurrency is 1** (the model session is shared); export concurrency is user-configurable 1-2 (`exportConcurrency`, no UI yet beyond defaults).
37. **Copy to clipboard** reuses the Export dialog's last-used options (current image, no file written).
38. **`success-fg` token** for success _text_ (4.5:1); `success` stays for dots/graphics (3:1). Dark `primary` lightened to `#dd7d44` so primary text on muted backgrounds passes AA.
39. **Menus are non-modal** (`modal={false}`): Radix's modal menus hide the rest of the page with `aria-hidden` while it stays focusable, which axe flags (`aria-hidden-focus`).
40. **Destructive confirmations:** unsaved changes, clear recent list, clear history, discard recovered work. Overwriting an existing project file is handled by the OS save dialog; exports never overwrite (auto-numbered), so there is no overwrite prompt.
41. **Toast actions close their toast**; errors never auto-dismiss.
42. **Quality (BiRefNet) model is wired but unvalidated:** no model file was available in this environment; its preprocessing constants and sigmoid come from the model's documentation. Test it with a real file before relying on it.
43. **`photom --smoke-test`** is part of the shipped binary (not a separate test harness) so CI can verify the exact packaged build: bundled model, ONNX Runtime library, file access. It writes its result to `--smoke-out` because Windows release builds have no console.
44. **The inference session is unloaded before exit** (`RunEvent::Exit`): tearing ONNX Runtime down while its thread pool is alive aborts the process (found by the smoke test).
45. **Release bundles ship only the fp16 model**, selected by `tauri.release.conf.json` (explicit resource list). Local/dev builds bundle whatever is in `resources/models`.
46. **Updater:** `tauri-plugin-updater` with a minisign key, `requireSignedVersion` on, no JS-side updater permission (all calls go through our own Rust commands), checks only on click. The committed public key is a development key; real releases must use their own (docs/RELEASING.md).
47. **Windows WebView2:** default installer downloads WebView2 only if missing; a separate `windows-offline` installer embeds it for machines that are never online.
48. **No git history exists in this working directory**, so changelog generation (`scripts/changelog.mjs`) and the release workflow were implemented and unit-tested but not run against real commits/tags here.
49. **`PHOTOM_MODELS_DIR`** adds a model search folder in any build (CI smoke tests use it for unbundled binaries). `PHOTOM_UPDATE_URL` overrides the update feed in **debug builds only**.
