# Performance (Section 7 targets)

Measured on the development machine: an **Intel x86_64 MacBook** (CPU-only inference, no GPU), release builds for Rust, headless Chromium (software rendering) for the UI. Real GPUs and newer CPUs are faster; Windows numbers are measured in CI/release testing.

| Target                                                      | Result                                                                                                                                                              | How it was measured                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12 MP background removal < 6 s on a laptop CPU (Fast model) | **3.6 s cold (includes loading the model), 1.26 s warm**                                                                                                            | `cargo test --release -- twelve_megapixel_jpeg_end_to_end --nocapture` (decode EXIF-rotated 12 MP JPEG, preprocess, ONNX inference, postprocess)      |
| Brush strokes at 60 fps on a 12 MP image                    | **476 frames, average 16.7 ms (vsync-locked 60 fps), p95 19.1 ms**                                                                                                  | `e2e/perf.spec.ts`: a 240-step stroke (size 120) on a 4000x3000 image edited at the 2048x1536 working size                                            |
| Refine sliders update the preview in < 200 ms               | **102-115 ms** per update                                                                                                                                           | `e2e/perf.spec.ts`: Feather changes on the same image; also `computeRefined` at 2560x1920 measured 142 ms before the working size was reduced to 2048 |
| Cold start to interactive UI < 2 s                          | **~0.3 s** (dev server, includes on-the-fly module transforms)                                                                                                      | `e2e/perf.spec.ts`: navigation to "Open Images" visible. Release-build startup is measured with the installer in Phase 6                              |
| Memory: release image buffers when switching images         | **JS heap flat: 77 MB -> 77 MB after 12 switches between 12 MP images**; Rust process returns to its baseline after every export                                    | `e2e/perf.spec.ts`; `twelve_mp_batch_is_fast_and_does_not_leak` (16 exports, RSS growth 0 MB)                                                         |
| Batch items streamed one at a time                          | Yes (1 worker by default, max 2 for decode/encode)                                                                                                                  | `infra/job_queue.rs`                                                                                                                                  |
| Installer under 150 MB with the Fast model                  | **Model 90.6 MB** (was 178.6 MB). ONNX Runtime (~15-30 MB) + app (~10 MB) keep the installer at roughly 120-135 MB; **exact installer size is verified in Phase 6** | `scripts/make-fast-model.py`; see below                                                                                                               |

## Other measurements

- **12 MP export** (refine + crop + resize + PNG level 6): **~0.93 s per image**, steady across 16 consecutive images.
- **fp16 Fast model**: weights stored as float16 (Cast back to float32 at load). Masks are identical to the float32 model (IoU 1.0000, mean difference 0.001/255) and inference speed is the same (0.82 s vs 0.75 s on a 900x700 image). `cargo test --release -- --ignored fp16 --nocapture`.
- **Mask maths** (TypeScript, 2560x1920 = 4.9 MP): soft threshold 36 ms, Gaussian blur ~100 ms, erode/dilate ~130 ms, compose 37 ms; the working size is 2048 on the longest side, so the default refine costs about 90 ms.

## How the targets are met

- Interactive editing never touches the full-resolution image: a 2048 px working preview and mask are prepared once per image, and the brush only writes the dirty rectangle of that buffer (`MaskSession.update`).
- Refine recomputes are coalesced to one per animation frame while a slider is dragged.
- Pan/zoom/brush/Before-After run through refs and `requestAnimationFrame`, not React renders.
- Export re-applies the same maths at full resolution in Rust, one image at a time.
- The ONNX session is created once and kept warm.

## Not measured here

- Windows DirectML GPU speed-ups and macOS CoreML (no such hardware in this environment).
- Release-build cold start and installer size (Phase 6 builds installers).
- The Quality (BiRefNet) model: it needs a user-supplied file, which was not available.
