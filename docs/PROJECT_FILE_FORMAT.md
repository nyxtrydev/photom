# `.photom` project format (version 2)

A project is a single zip archive. Images that are already compressed (PNG/JPEG) are stored without extra compression; JSON is deflated.

```
project.photom
├─ manifest.json                 format version, app version, ids, image list
├─ images/<id>/original.<ext>    embedded copy of the source image (omitted for linked/autosave projects)
├─ images/<id>/mask_model.png    raw model mask, 8-bit gray, source resolution
├─ images/<id>/state.json        refine params, background, output size/crop, brush strokes, split
├─ images/<id>/background.<ext>  background picture, if the background is an image
└─ thumbs/<id>.png               thumbnail
```

## manifest.json

| Field                                                    | Meaning                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `formatVersion`                                          | integer, currently `2`                                                                                                                                 |
| `appVersion`, `projectId`, `name`, `created`, `modified` | metadata (`projectId` also names the autosave file)                                                                                                    |
| `originalPath`                                           | where the user saved it (recorded in autosaves so recovery can offer it back)                                                                          |
| `activeId`                                               | image that was open                                                                                                                                    |
| `images[]`                                               | `id`, `name`, `width`, `height`, `format`, `originalFile` or `sourcePath` (embedded vs linked), `maskFile`, `stateFile`, `thumbFile`, `backgroundFile` |

## state.json

Editor state that is part of the document (history and view position are not saved):
`refine {threshold, feather, edgeShift}`, `background {kind, color, fit, image}`, `output {width, height, lockRatio, cropToSubject}`, `strokes[]`, `split`, and (format 2) `shadow`.
Each stroke is `{mode: "keep"|"erase", size, hardness, points: [[x, y, pressure], ...]}` in **source pixels**. The manual edit layer is therefore stored as stroke deltas, not a bitmap (`mask_edits.png` from the original spec is not written; strokes are authoritative and are replayed at any resolution). Values are clamped/sanitised when loaded, so a hand-edited file cannot crash the editor.

### `shadow` (format 2)

```json
"shadow": {
  "enabled": true, "autoExpand": true, "linearLight": false, "groundY": null, "presetId": null,
  "layers": [
    { "type": "drop", "visible": true, "angle": 135, "distance": 24, "blur": 32,
      "spread": 0, "opacity": 0.45, "color": "#2b1a10" }
  ]
}
```

`linearLight` (default false) blends layer colours in linear light. Layer types: `drop` (`angle, distance, blur, spread, opacity, color`), `contact` (`size, softness, groundOffset, opacity, color`) `cast` (`angle, elevation, length, squash, falloff, blur, blurGrowth, opacity, color`) and `reflection` (`gap, fade, blur, opacity`; it has no colour because it uses the subject's); every layer also has `visible`. `groundY` is a fraction of the image height (`null` = the subject's lowest pixel). Layer order is draw order, bottom to top.

Distances, blur and spread are in **source pixels**; `angle` is the light direction in degrees (135 = light from the upper left, shadow falls lower right); `opacity` is 0..1. Absent or `null` means no shadow, so projects saved by format 1 open exactly as before. Unknown layer types and out-of-range values are skipped or clamped on load. The editor and the export share the same canvas-growth maths (`tests/fixtures/shadow_bounds.json`).

## Saving

1. Build the archive in a temp file next to the destination (`.<name>.<rand>.tmp`), fsync it.
2. If the destination exists, rename it to `<name>.photom.bak` (replacing an older `.bak`), then rename the temp file into place. If the final rename fails the previous file is put back.
3. A failed save leaves the existing file untouched and removes the temp file.

## Autosave

Written to `<app data>/autosave/<projectId>.photom.tmp` by the same writer, **linking** originals (fast) except originals that live in Photom's own cache (those are embedded). Never touches the user's file. Removed by a successful Save, by discarding changes, or by a clean exit. Leftovers are offered as _Restore / Discard_ at the next start; a restored project is marked unsaved and tied to the original path only when the user saves.

## Opening and validation

- The archive and manifest are validated; entries have size caps; image ids may only contain `[A-Za-z0-9_-]` (no path traversal).
- Opening reads into a scratch registry first, so a corrupt file never destroys the current session.
- A damaged project reports `ProjectCorrupt`; if a `.bak` exists the UI offers to open it (as unsaved work, never overwriting the damaged file silently).
- Linked originals that no longer exist are skipped with a warning.

## Versioning and migration

`migrate_manifest` upgrades older manifests in memory (v0 -> v1: `file` renamed to `originalFile`, missing ids/dates filled; v1 -> v2: only the version number, since a missing `shadow` already means "none"). A manifest with a higher `formatVersion` than the app understands is rejected with a clear message instead of being misread.

### Shadow presets

Custom shadow presets are not part of a project; they live in the app settings (`shadowPresets`): `{ id, name, refSide, autoExpand, layers[] }` with the same layer objects as above, pixel values relative to `refSide` (1500). They are scaled to the image when applied.

### Upscaled version (format 3)

A kept upscale is a derived asset: `images/<id>/upscaled_2x.png`, `upscaled_4x.png` or `upscaled_custom.png` (an exact target size). The manifest entry for the image gains `upscaled: { file, width, height, scale, engine }` (`scale` is `null` for a custom size; `engine` is `standard` or, later, `ai`). `state.json` gains `upscale: { scale, width, height, engine }` so the parameters travel with the editor state. On open the picture is the truth: parameters without a file are ignored. Projects of format 1 and 2 open with no upscale; the migration only changes the version number. The original image is never modified.
