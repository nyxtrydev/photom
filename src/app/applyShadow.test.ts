import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/export', () => ({
  exportPng: vi.fn(),
  removeBackgroundBatch: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  copyToClipboard: vi.fn(),
}));
vi.mock('@/api/shadow', () => ({
  shadowApplyBatch: vi.fn(),
  listShadowPresets: vi.fn(),
  saveShadowPreset: vi.fn(),
  deleteShadowPreset: vi.fn(),
}));
vi.mock('@/api/settings', () => ({
  revealPath: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { getJob } from '@/api/export';
import { shadowApplyBatch } from '@/api/shadow';
import { newCastLayer, newContactLayer, newDropLayer, type DropLayer } from '@/canvas/shadow';
import { shadowFromPreset, BUILT_IN_SHADOW_PRESETS } from '@/canvas/shadowPresets';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import { useUiStore } from '@/stores/uiStore';
import type { JobSnapshot } from '@/types/export';
import { applyShadowToAll, handleItemComplete, refreshJob, retryFailed } from './exportActions';

const SIZES = [
  [6000, 4000],
  [1200, 800],
  [3000, 3000],
  [800, 1200],
  [4000, 3000],
  [1500, 1000],
];
const meta = (i: number) => ({
  id: `i${i}`,
  path: `/x/${i}.jpg`,
  name: `${i}.jpg`,
  width: SIZES[i % SIZES.length]![0]!,
  height: SIZES[i % SIZES.length]![1]!,
  format: 'jpeg',
  thumbnailPath: '',
});
const mask = (id: string) => ({
  id,
  maskPath: `/m/${id}.png`,
  width: 10,
  height: 10,
  boundingBox: null,
  durationMs: 1,
  device: 'cpu' as const,
});

const snap = (
  items: [string, 'done' | 'failed'][],
  over: Partial<JobSnapshot> = {},
): JobSnapshot => ({
  jobId: 'j1',
  kind: 'applyShadow',
  status: 'done',
  done: items.length,
  total: items.length,
  items: items.map(([id, status]) => ({
    id,
    label: id,
    status,
    error:
      status === 'failed'
        ? { code: 'ExportFailed', message: 'No subject was found', details: null }
        : null,
    result: status === 'done' ? { id, applied: true } : null,
  })),
  ...over,
});

function load(count: number, withMask: (i: number) => boolean = () => true) {
  const images = Array.from({ length: count }, (_, i) => meta(i));
  useProjectStore.getState().load({
    name: 'p',
    path: null,
    images,
    masks: Object.fromEntries(images.filter((_, i) => withMask(i)).map((m) => [m.id, mask(m.id)])),
    dirty: false,
  });
  useEditorStore.setState({ states: {}, activeId: null });
  for (const m of images) useEditorStore.getState().ensureState(m.id, m.width, m.height);
  useEditorStore.getState().setActive('i0');
  return images;
}

const stateOf = (id: string) => useEditorStore.getState().states[id]!;
const notices = () => useUiStore.getState().notices.map((n) => n.message);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ notices: [] });
  useQueueStore.setState({ jobs: {}, requests: {}, dialogJobId: null, reported: {} });
});

describe('Apply to all images', () => {
  it('sends every other image with a cut-out, each with the shadow scaled to its own size', async () => {
    load(40);
    const grounded = BUILT_IN_SHADOW_PRESETS.find((p) => p.id === 'grounded')!;
    useEditorStore.getState().setShadow('i0', (cur) => shadowFromPreset(grounded, 6000, cur)); // i0 is 6000 x 4000
    vi.mocked(shadowApplyBatch).mockResolvedValue('j1');
    vi.mocked(getJob).mockResolvedValue(snap([], { status: 'running' }));

    await applyShadowToAll();

    const [items, label] = vi.mocked(shadowApplyBatch).mock.calls[0]!;
    expect(label).toBe('grounded');
    expect(items).toHaveLength(39); // every image but the source
    expect(items.map((i) => i.id)).not.toContain('i0');
    // Consistency: whatever the image size, the preset looks the same relative to it.
    for (const it of items) {
      const m = meta(Number(it.id.slice(1)));
      const side = Math.max(m.width, m.height);
      const sh = (it.state as { shadow: { presetId: string; layers: Record<string, number>[] } })
        .shadow;
      expect(sh.presetId).toBe('grounded');
      const contact = sh.layers[0]!;
      expect(contact.size! / side).toBeCloseTo(50 / 1500, 5);
      expect(contact.softness! / side).toBeCloseTo(14 / 1500, 5);
      expect(sh.layers[1]!.blur! / side).toBeCloseTo(8 / 1500, 5);
      expect(sh.layers[1]!.angle).toBe(160); // angles and opacity do not scale
    }
    // The job is shown in the progress dialog.
    expect(useQueueStore.getState().dialogJobId).toBe('j1');
    expect(useQueueStore.getState().requests['j1']!.kind).toBe('applyShadow');
  });

  it('skips images without a cut-out and says so', async () => {
    load(6, (i) => i % 2 === 0); // i0, i2, i4 have masks
    useEditorStore.getState().setShadow('i0', () => ({
      enabled: true,
      autoExpand: true,
      linearLight: false,
      groundY: 0.5,
      presetId: null,
      layers: [newDropLayer()],
    }));
    vi.mocked(shadowApplyBatch).mockResolvedValue('j1');
    vi.mocked(getJob).mockResolvedValue(snap([], { status: 'running' }));
    await applyShadowToAll();
    const [items] = vi.mocked(shadowApplyBatch).mock.calls[0]!;
    expect(items.map((i) => i.id)).toEqual(['i2', 'i4']);
    expect(notices().join(' ')).toMatch(/3 images have no cut-out yet and were skipped/);
    // A manual ground line belongs to its own image; the others detect theirs.
    expect((items[0]!.state as { shadow: { groundY: unknown } }).shadow.groundY).toBeNull();
  });

  it('does nothing, politely, without a shadow or without other images', async () => {
    load(3);
    await applyShadowToAll(); // no shadow yet
    expect(shadowApplyBatch).not.toHaveBeenCalled();
    expect(notices().join(' ')).toMatch(/Add at least one shadow layer/);

    load(1);
    useEditorStore.getState().setShadow('i0', () => ({
      enabled: true,
      autoExpand: true,
      linearLight: false,
      groundY: null,
      presetId: null,
      layers: [newDropLayer()],
    }));
    await applyShadowToAll();
    expect(shadowApplyBatch).not.toHaveBeenCalled();
    expect(notices().join(' ')).toMatch(/no other images with a cut-out/);
  });

  it('adopts the shadow for images that pass, one undo step each, and only those', async () => {
    load(4);
    useEditorStore.getState().setShadow('i0', () => ({
      enabled: true,
      autoExpand: true,
      linearLight: true,
      groundY: null,
      presetId: null,
      layers: [newContactLayer(), newCastLayer()],
    }));
    vi.mocked(shadowApplyBatch).mockResolvedValue('j1');
    vi.mocked(getJob).mockResolvedValue(snap([], { status: 'running' }));
    await applyShadowToAll();

    handleItemComplete({ jobId: 'j1', itemId: 'i1', result: { id: 'i1', applied: true } });
    handleItemComplete({ jobId: 'j1', itemId: 'i1', result: { id: 'i1', applied: true } }); // repeat
    expect(stateOf('i1').shadow!.layers.map((l) => l.type)).toEqual(['contact', 'cast']);
    expect(stateOf('i1').shadow!.linearLight).toBe(true);
    expect(stateOf('i1').undo).toHaveLength(1); // adopted once
    expect(stateOf('i2').shadow).toBeNull(); // not yet reported

    // The final summary adopts the rest that passed and leaves the failed one alone.
    vi.mocked(getJob).mockResolvedValue(
      snap([
        ['i1', 'done'],
        ['i2', 'done'],
        ['i3', 'failed'],
      ]),
    );
    await refreshJob('j1');
    await vi.waitFor(() => expect(stateOf('i2').shadow).not.toBeNull());
    expect(stateOf('i3').shadow).toBeNull();
    expect(stateOf('i1').undo).toHaveLength(1);
    expect(notices().join(' ')).toMatch(/Shadow applied to 2 of 3 images/);

    useEditorStore.getState().undo('i2');
    expect(stateOf('i2').shadow).toBeNull();
  });

  it('retry sends only the failed images again, with the shadow they were checked with', async () => {
    load(3);
    useEditorStore.getState().setShadow('i0', () => ({
      enabled: true,
      autoExpand: true,
      linearLight: false,
      groundY: null,
      presetId: null,
      layers: [newDropLayer()],
    }));
    vi.mocked(shadowApplyBatch).mockResolvedValueOnce('j1').mockResolvedValueOnce('j2');
    vi.mocked(getJob).mockResolvedValue(snap([], { status: 'running' }));
    await applyShadowToAll();
    vi.mocked(getJob).mockResolvedValue(
      snap([
        ['i1', 'done'],
        ['i2', 'failed'],
      ]),
    );
    await refreshJob('j1');
    await retryFailed('j1');
    const [items] = vi.mocked(shadowApplyBatch).mock.calls[1]!;
    expect(items.map((i) => i.id)).toEqual(['i2']);
    expect((items[0]!.state as { shadow: { layers: unknown[] } }).shadow.layers).toHaveLength(1);
    expect(useQueueStore.getState().requests['j2']!.shadows!['i2']).toBeDefined();
  });

  it('a layer edit remains a plain DropLayer (sanity check for the scaled copy)', () => {
    const d = BUILT_IN_SHADOW_PRESETS[0]!.layers[0]!;
    expect((d as unknown as DropLayer).distance).toBe(14);
  });
});
