# Photom

**Remove image backgrounds on your own computer.** Photom cuts out the subject of a photo, lets you refine the result, and exports a transparent PNG. Everything runs offline: no account, no uploads, no telemetry.

- Drag in photos (PNG, JPG, WEBP, BMP, TIFF) or whole folders
- One-click background removal with a bundled AI model, GPU-accelerated where available
- Before/After slider, Keep/Erase brushes, threshold / feather / edge-shift refinement, solid-colour or picture backgrounds
- Export transparent PNGs: crop to subject with exact padding, custom size, presets, safe filenames that never overwrite
- Batch processing with pause, resume and cancel
- Projects (`.photom`) with autosave and crash recovery; undo/redo across everything

Built with Tauri 2 (Rust), React, TypeScript and ONNX Runtime.

## Using it

Download the installer for your system from the [Releases](../../releases) page, or build it yourself (below). Open Photom, drop an image on the window, press **Remove BG**, then **Export PNG**.

Photom is private by design. It never uploads your images, and the only network feature is the **Check for updates** button in Settings > About, which does nothing until you click it.

## Building from source

Requirements: **Node 22+**, **Rust (stable)**, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. Python 3 with `onnx numpy` is optional (it builds the compact model).

```bash
git clone <repo> && cd photom
npm install
npm run model:fetch        # downloads the background-removal model (once; ~180 MB) and verifies its checksum
npm run tauri dev          # run the app
npm run tauri build        # installers for your OS (see docs/RELEASING.md for signing and the release flow)
```

**Intel Mac:** ONNX Runtime has no prebuilt binary for Intel Macs. Download `onnxruntime-osx-x86_64-1.22.0.tgz` from the [ONNX Runtime releases](https://github.com/microsoft/onnxruntime/releases/tag/v1.22.0) and extract it into `src-tauri/vendor/`. Windows, Linux and Apple Silicon need nothing extra.

### The model

The Fast model is ISNet general-use (Apache-2.0). `npm run model:fetch` downloads it; with Python + `onnx` installed it also builds the 90 MB float16-weights file that release builds ship (identical output, half the size). To use a different model, import an `.onnx` file in **Settings > Model**. See `docs/DECISIONS.md` for details.

## Development

```bash
npm run lint && npm run typecheck && npm test         # frontend: ESLint, TypeScript, Vitest
npm run test:scripts                                  # release tooling
npm run e2e                                           # Playwright end-to-end + accessibility audits
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

| Folder                   | What lives there                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/`                   | React UI: screens, dialogs, the canvas editor (`src/canvas`), Zustand stores, typed IPC wrappers (`src/api`) |
| `src-tauri/src/commands` | IPC entry points (validation only)                                                                           |
| `src-tauri/src/services` | Image I/O, ONNX inference, mask maths, export, project files, settings, history                              |
| `src-tauri/src/infra`    | Model manager, job queue, logging                                                                            |
| `e2e/`                   | Playwright tests; they drive the real UI against a mocked Tauri backend                                      |
| `docs/`                  | Architecture, decisions, file format, performance, releasing                                                 |

Useful commands:

- `photom --smoke-test` runs the whole pipeline once inside the real app and exits 0/1 (what CI runs on every platform).
- `UPDATE_FIXTURES=1 npx vitest run src/canvas/parity` regenerates the TypeScript/Rust mask-maths parity fixture after an intentional change.

### Contributing

1. Open an issue or pick one, and keep changes small and focused.
2. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`). The changelog and version bump are generated from them.
3. Every feature needs tests (unit and, for UI, a Playwright test), accessible markup (labels, keyboard, contrast), strings in `src/i18n/strings.ts`, and a note in `docs/` when it changes behaviour.
4. Before opening a PR run the commands above; CI runs them on Windows, macOS and Linux.
5. Never add anything that sends user images or data over the network.

## Documentation

- [Architecture](docs/ARCHITECTURE.md), [Decisions](docs/DECISIONS.md), [Design tokens](docs/DESIGN_TOKENS.md)
- [Project file format](docs/PROJECT_FILE_FORMAT.md), [Performance](docs/PERFORMANCE.md), [Releasing](docs/RELEASING.md)
- [Third-party licences](THIRD_PARTY_LICENSES.md)

## Optional models

Background removal works from the first launch. Extra AI tools use optional models that you install with one click (Settings > Models) and that then work fully offline. See [docs/MODEL_HUB.md](docs/MODEL_HUB.md) for how models are catalogued, verified and published.
