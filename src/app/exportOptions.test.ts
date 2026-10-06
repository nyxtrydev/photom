import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '@/stores/editorStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  applyPreset,
  BUILT_IN_PRESETS,
  DEFAULT_EXPORT_OPTIONS,
  presetFrom,
  toApiOptions,
} from '@/types/export';
import {
  allPresets,
  initialExportOptions,
  isPreset,
  matchingPreset,
  previewFilename,
} from './exportOptions';

const meta = (id: string, w = 400, h = 300) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: w,
  height: h,
  format: 'jpeg',
  thumbnailPath: '',
});

beforeEach(() => {
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, loaded: true });
  useProjectStore
    .getState()
    .load({ name: 'p', path: null, images: [meta('a'), meta('b')], masks: {}, dirty: false });
  useEditorStore.setState({ states: {}, activeId: null });
  useEditorStore.getState().ensureState('a', 400, 300);
  useEditorStore.getState().setActive('a');
});

describe('initialExportOptions', () => {
  it('starts from defaults with the last used folder', () => {
    useSettingsStore.setState({
      lastUsedFolders: { export: '/last' },
      defaultExportFolder: '/default',
    });
    expect(initialExportOptions().folder).toBe('/last');
    useSettingsStore.setState({ lastUsedFolders: {} });
    expect(initialExportOptions().folder).toBe('/default');
    useSettingsStore.setState({ defaultExportFolder: null });
    expect(initialExportOptions().folder).toBe('');
  });

  it("reflects the active image's Output panel (custom size, crop)", () => {
    useEditorStore.getState().setOutput('a', { width: 200, height: 150, cropToSubject: true });
    const o = initialExportOptions();
    expect(o.size).toMatchObject({ mode: 'custom', width: 200, height: 150 });
    expect(o.crop.enabled).toBe(true);
  });

  it('uses original size when the Output panel was not changed', () => {
    expect(initialExportOptions().size).toMatchObject({
      mode: 'original',
      width: 400,
      height: 300,
    });
  });

  it('applies the requested preset and falls back to the default preset setting', () => {
    expect(initialExportOptions({ presetId: 'web' })).toMatchObject({
      compression: 9,
      size: { maxSide: 2000 },
    });
    useSettingsStore.setState({ defaultPreset: 'print' });
    expect(initialExportOptions().compression).toBe(3);
  });

  it('only offers "All images" when there is more than one', () => {
    expect(initialExportOptions({ scope: 'all' }).scope).toBe('all');
    useProjectStore.getState().removeImage('b');
    expect(initialExportOptions({ scope: 'all' }).scope).toBe('current');
  });
});

describe('presets', () => {
  it('applying a preset leaves folder, scope and filename alone', () => {
    const base = {
      ...DEFAULT_EXPORT_OPTIONS,
      folder: '/out',
      scope: 'all' as const,
      filenameTemplate: '{index}',
    };
    const web = BUILT_IN_PRESETS.find((p) => p.id === 'web')!;
    const o = applyPreset(base, web.options);
    expect([o.folder, o.scope, o.filenameTemplate]).toEqual(['/out', 'all', '{index}']);
    expect(o.compression).toBe(9);
  });

  it('recognises which preset matches, or none', () => {
    const presets = allPresets([]);
    const web = presets.find((p) => p.id === 'web')!;
    expect(matchingPreset(applyPreset(DEFAULT_EXPORT_OPTIONS, web.options), presets)?.id).toBe(
      'web',
    );
    expect(matchingPreset({ ...DEFAULT_EXPORT_OPTIONS, compression: 4 }, presets)).toBeNull();
  });

  it('ignores malformed custom presets from settings', () => {
    const good = { id: 'c1', name: 'Mine', options: presetFrom(DEFAULT_EXPORT_OPTIONS) };
    const list = allPresets([good, null, 'x', { id: 1 }, { id: 'z', name: 'n' }]);
    expect(list.map((p) => p.id)).toEqual(['web', 'print', 'original', 'c1']);
    expect(isPreset(good)).toBe(true);
  });
});

describe('API mapping', () => {
  it('strips UI-only fields before sending to the backend', () => {
    const api = toApiOptions({ ...DEFAULT_EXPORT_OPTIONS, scope: 'all', folder: '/o' });
    expect(api).not.toHaveProperty('scope');
    expect(api.size).not.toHaveProperty('lockRatio');
    expect(api).toMatchObject({
      background: 'transparent',
      compression: 6,
      folder: '/o',
      filenameTemplate: '{name}-photom.png',
    });
  });
});

describe('previewFilename (mirrors the backend template)', () => {
  const d = new Date(2026, 9, 5);
  it('expands tokens and pads the index to the batch size', () => {
    expect(previewFilename('{name}-photom.png', 'dog', 1, 1, d)).toBe('dog-photom.png');
    expect(previewFilename('{index}_{name}_{date}', 'dog', 3, 40, d)).toBe('03_dog_2026-10-05.png');
    expect(previewFilename('{index}', 'x', 7, 1000, d)).toBe('0007.png');
  });
  it('is safe: no separators, always .png, never empty', () => {
    expect(previewFilename('../{name}', 'a/b', 1, 1, d)).toBe('_a_b.png');
    expect(previewFilename('', 'dog', 1, 1, d)).toBe('dog-photom.png');
    expect(previewFilename('a<b>.PNG', 'x', 1, 1, d)).toBe('a_b_.PNG');
    expect(previewFilename('...', 'x', 1, 1, d)).toBe('photom.png');
  });
});
