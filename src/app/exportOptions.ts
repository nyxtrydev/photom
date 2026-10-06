import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  applyPreset,
  BUILT_IN_PRESETS,
  DEFAULT_EXPORT_OPTIONS,
  presetFrom,
  type ExportOptionsUi,
  type ExportPreset,
  type PresetOptions,
} from '@/types/export';

/** Narrow an unknown settings entry to a usable custom preset. */
export function isPreset(v: unknown): v is ExportPreset {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<ExportPreset>;
  const o = p.options as Partial<PresetOptions> | undefined;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    !!o &&
    typeof o.compression === 'number' &&
    typeof o.sizeMode === 'string' &&
    typeof o.background === 'string' &&
    !!o.crop
  );
}

export function allPresets(custom: unknown[]): ExportPreset[] {
  return [...BUILT_IN_PRESETS, ...custom.filter(isPreset)];
}

export const samePreset = (a: PresetOptions, b: PresetOptions) =>
  a.background === b.background &&
  a.sizeMode === b.sizeMode &&
  (a.maxSide ?? null) === (b.maxSide ?? null) &&
  a.crop.enabled === b.crop.enabled &&
  a.crop.padding === b.crop.padding &&
  a.compression === b.compression;

/** The preset whose settings exactly match `options`, if any. */
export function matchingPreset(
  options: ExportOptionsUi,
  presets: ExportPreset[],
): ExportPreset | null {
  const mine = presetFrom(options);
  return presets.find((p) => samePreset(p.options, mine)) ?? null;
}

/** Starting values for the dialog: the active image's Output settings, last folder, default preset. */
export function initialExportOptions(
  request: { scope?: 'current' | 'all'; presetId?: string } = {},
): ExportOptionsUi {
  const { activeId, states } = useEditorStore.getState();
  const state = activeId ? states[activeId] : undefined;
  const settings = useSettingsStore.getState();
  const imageCount = useProjectStore.getState().images.length;

  let opts: ExportOptionsUi = {
    ...DEFAULT_EXPORT_OPTIONS,
    scope: request.scope === 'all' && imageCount > 1 ? 'all' : 'current',
    folder: settings.lastUsedFolders.export ?? settings.defaultExportFolder ?? '',
  };

  const presetId = request.presetId ?? settings.defaultPreset ?? undefined;
  const preset = presetId
    ? allPresets(settings.exportPresets).find((p) => p.id === presetId)
    : undefined;
  if (preset) opts = applyPreset(opts, preset.options);

  if (state) {
    const { output, source } = state;
    const custom = output.width !== source.width || output.height !== source.height;
    opts = {
      ...opts,
      crop: { enabled: output.cropToSubject || opts.crop.enabled, padding: opts.crop.padding },
      size: custom
        ? {
            ...opts.size,
            mode: 'custom',
            width: output.width,
            height: output.height,
            lockRatio: output.lockRatio,
          }
        : { ...opts.size, width: source.width, height: source.height, lockRatio: output.lockRatio },
    };
  }
  return opts;
}

/** Client-side mirror of the backend's filename template expansion, for the live preview. */
export function previewFilename(
  template: string,
  name: string,
  index = 1,
  total = 1,
  date = new Date(),
): string {
  const t = template.trim() === '' ? '{name}-photom.png' : template;
  const width = Math.max(2, String(Math.max(1, total)).length);
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let out = t
    .replaceAll('{name}', name)
    .replaceAll('{index}', String(index).padStart(width, '0'))
    .replaceAll('{date}', d)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!out) out = 'photom';
  if (!out.toLowerCase().endsWith('.png')) out += '.png';
  return out;
}
