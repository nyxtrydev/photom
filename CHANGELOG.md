# Changelog

All notable changes to Photom. Generated from conventional commits by `scripts/changelog.mjs`.

## 0.1.0 (2026-10-05)

### Features

- Offline background removal with a bundled model (ISNet general-use, float16 weights), CPU and GPU where available
- Editor: Before/After slider, Keep/Erase brushes, threshold, feather and edge-shift refinement, solid-colour and picture backgrounds, undo/redo
- Export transparent PNGs: crop to subject with exact padding, custom size, presets, safe never-overwrite file names, copy to clipboard
- Batch processing with pause, resume, cancel, per-item status and retry
- `.photom` projects with atomic saves, backup, autosave and crash recovery; recent projects; History
- Remappable keyboard shortcuts, light and dark themes, WCAG AA contrast, keyboard-only operation
- Opt-in signed updates; file association for `.photom`

### Maintenance

- Windows, macOS and Linux installers, CI with end-to-end and accessibility tests, third-party licence bundle
