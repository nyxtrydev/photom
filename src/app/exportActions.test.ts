import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/export', () => ({
  exportPng: vi.fn(),
  removeBackgroundBatch: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue(undefined),
  pauseJob: vi.fn().mockResolvedValue(undefined),
  resumeJob: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn(),
}));
vi.mock('@/api/settings', () => ({
  revealPath: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn(),
  updateSettings: vi.fn(async (s: unknown) => s),
}));

import { copyToClipboard, exportPng, getJob, removeBackgroundBatch } from '@/api/export';
import { revealPath } from '@/api/settings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { DEFAULT_EXPORT_OPTIONS, type JobSnapshot } from '@/types/export';
import {
  buildItems,
  copyCurrentToClipboard,
  handleItemComplete,
  refreshJob,
  retryFailed,
  startBatchRemoval,
  startExport,
} from './exportActions';

const meta = (id: string) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: 400,
  height: 300,
  format: 'jpeg',
  thumbnailPath: '',
});
const mask = (id: string, path = `/m/${id}.png`) => ({
  id,
  maskPath: path,
  width: 400,
  height: 300,
  boundingBox: null,
  durationMs: 5,
  device: 'cpu' as const,
});

const snap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  jobId: 'j',
  kind: 'export',
  status: 'done',
  done: 1,
  total: 1,
  items: [],
  ...over,
});
const done = (id: string, outputPath = `/out/${id}-photom.png`) => ({
  id,
  label: `${id}.jpg`,
  status: 'done' as const,
  error: null,
  result: { id, outputPath, width: 10, height: 10, bytes: 5 },
});

const lastNotice = () => useUiStore.getState().notices.at(-1);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ notices: [] });
  useQueueStore.setState({ jobs: {}, requests: {}, dialogJobId: null, reported: {} });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, loaded: true });
  useProjectStore.getState().load({
    name: 'p',
    path: null,
    images: [meta('a'), meta('b'), meta('c')],
    masks: { a: mask('a') },
    dirty: false,
  });
  useEditorStore.setState({ states: {}, activeId: null });
  for (const id of ['a', 'b', 'c']) useEditorStore.getState().ensureState(id, 400, 300);
  useEditorStore.getState().setActive('b');
});

describe('buildItems', () => {
  it('current = the active image, all = every image, each with its own persisted state', () => {
    useEditorStore.getState().setRefine('a', { feather: 9 });
    expect(buildItems('current').map((i) => i.id)).toEqual(['b']);
    const all = buildItems('all');
    expect(all.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect((all[0]!.state as { refine: { feather: number } }).refine.feather).toBe(9);
    expect((all[1]!.state as { refine: { feather: number } }).refine.feather).toBe(2);
    expect(Object.keys(all[0]!.state as object).sort()).toEqual([
      'background',
      'output',
      'refine',
      'split',
      'strokes',
    ]);
  });
  it('accepts an explicit id list and nothing when no image is active', () => {
    expect(buildItems(['c', 'a']).map((i) => i.id)).toEqual(['c', 'a']);
    useEditorStore.setState({ activeId: null });
    expect(buildItems('current')).toEqual([]);
  });
});

describe('job reporting', () => {
  it('single export: success toast with Open folder and Copy path actions', async () => {
    vi.mocked(getJob).mockResolvedValue(snap({ items: [done('b')] }));
    await refreshJob('j');
    const n = lastNotice()!;
    expect(n.kind).toBe('success');
    expect(n.message).toBe('Exported b-photom.png');
    expect(n.actions?.map((a) => a.label)).toEqual(['Open folder', 'Copy path']);
    n.actions![0]!.onClick();
    expect(revealPath).toHaveBeenCalledWith('/out/b-photom.png');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    n.actions![1]!.onClick();
    expect(writeText).toHaveBeenCalledWith('/out/b-photom.png');
  });

  it('is reported exactly once even if the job is refreshed many times', async () => {
    vi.mocked(getJob).mockResolvedValue(snap({ items: [done('b')] }));
    await refreshJob('j');
    await refreshJob('j');
    await refreshJob('j');
    expect(useUiStore.getState().notices).toHaveLength(1);
  });

  it('a running job produces no toast yet', async () => {
    vi.mocked(getJob).mockResolvedValue(snap({ status: 'running', items: [done('b')] }));
    await refreshJob('j');
    expect(useUiStore.getState().notices).toHaveLength(0);
    expect(useQueueStore.getState().jobs['j']?.status).toBe('running');
  });

  it('batch with failures is a warning that says how many failed', async () => {
    vi.mocked(getJob).mockResolvedValue(
      snap({
        total: 3,
        done: 3,
        items: [
          done('a'),
          {
            ...done('b'),
            status: 'failed',
            error: { code: 'ExportFailed', message: 'x' },
            result: null,
          },
          done('c'),
        ],
      }),
    );
    await refreshJob('j');
    expect(lastNotice()).toMatchObject({
      kind: 'warning',
      message: 'Exported 2 of 3 images',
      details: '1 image could not be exported.',
    });
  });

  it('a cancelled job says how far it got', async () => {
    vi.mocked(getJob).mockResolvedValue(
      snap({ status: 'cancelled', total: 5, items: [done('a'), done('b')] }),
    );
    await refreshJob('j');
    expect(lastNotice()).toMatchObject({ kind: 'info', message: 'Cancelled after 2 of 5 images.' });
  });

  it('if nothing could be exported it is an error, not a success', async () => {
    vi.mocked(getJob).mockResolvedValue(
      snap({
        items: [
          {
            ...done('a'),
            status: 'failed',
            error: { code: 'ExportFailed', message: 'x' },
            result: null,
          },
        ],
      }),
    );
    await refreshJob('j');
    expect(lastNotice()?.kind).toBe('error');
  });

  it('batch removal summary', async () => {
    vi.mocked(getJob).mockResolvedValue(
      snap({ kind: 'removeBackground', total: 2, items: [done('a'), done('b')] }),
    );
    await refreshJob('j');
    expect(lastNotice()).toMatchObject({
      kind: 'success',
      message: 'Removed the background from 2 of 2 images.',
    });
  });

  it('coalesces rapid refreshes into at most one extra request', async () => {
    let resolve!: (s: JobSnapshot) => void;
    vi.mocked(getJob).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    vi.mocked(getJob).mockResolvedValue(snap({ status: 'running', items: [] }));
    const first = refreshJob('j');
    void refreshJob('j');
    void refreshJob('j');
    resolve(snap({ status: 'running', items: [] }));
    await first;
    expect(vi.mocked(getJob).mock.calls.length).toBe(2);
  });
});

describe('batch removal results', () => {
  it('stores each finished mask and makes it undoable in the editor', async () => {
    vi.mocked(getJob).mockResolvedValue(snap({ status: 'running', items: [] }));
    handleItemComplete({ jobId: 'j', itemId: 'b', result: mask('b', '/m/b1.png') });
    expect(useProjectStore.getState().masks['b']?.maskPath).toBe('/m/b1.png');
    const s = useEditorStore.getState().states['b']!;
    expect(s.maskRev).toBe(1);
    expect(s.undo[0]).toMatchObject({ type: 'rerun', before: null });
  });

  it('remembers the previous mask for undo when re-running', () => {
    handleItemComplete({ jobId: 'j', itemId: 'a', result: mask('a', '/m/a2.png') });
    expect(useEditorStore.getState().states['a']!.undo[0]).toMatchObject({
      before: { maskPath: '/m/a.png' },
      after: { maskPath: '/m/a2.png' },
    });
  });

  it('ignores export results', () => {
    handleItemComplete({ jobId: 'j', itemId: 'b', result: { id: 'b', outputPath: '/o.png' } });
    expect(useProjectStore.getState().masks['b']).toBeUndefined();
  });
});

describe('starting jobs', () => {
  it('startBatchRemoval only targets images without a cut-out and opens the dialog', async () => {
    vi.mocked(removeBackgroundBatch).mockResolvedValue('j1');
    vi.mocked(getJob).mockResolvedValue(
      snap({ jobId: 'j1', kind: 'removeBackground', status: 'running', items: [] }),
    );
    await startBatchRemoval();
    expect(removeBackgroundBatch).toHaveBeenCalledWith(['b', 'c'], {
      model: 'fast',
      device: 'cpu',
    });
    expect(useQueueStore.getState().dialogJobId).toBe('j1');
  });

  it('says so when everything already has a cut-out', async () => {
    useProjectStore.getState().setMask(mask('b'));
    useProjectStore.getState().setMask(mask('c'));
    await startBatchRemoval();
    expect(removeBackgroundBatch).not.toHaveBeenCalled();
    expect(lastNotice()?.kind).toBe('info');
  });

  it('startExport refuses when there is nothing to export', async () => {
    useEditorStore.setState({ activeId: null });
    expect(await startExport({ ...DEFAULT_EXPORT_OPTIONS, folder: '/o' })).toBe(false);
    expect(exportPng).not.toHaveBeenCalled();
  });

  it('startExport turns a backend error into a notice and reports failure', async () => {
    vi.mocked(exportPng).mockRejectedValue({
      code: 'Permission',
      message: 'cannot write',
      details: null,
    });
    expect(await startExport({ ...DEFAULT_EXPORT_OPTIONS, folder: '/o' })).toBe(false);
    expect(lastNotice()?.kind).toBe('error');
  });

  it('retryFailed resends only the failed items with the original options', async () => {
    useQueueStore.setState({
      jobs: {
        j: snap({
          items: [
            done('a'),
            {
              ...done('b'),
              status: 'failed',
              error: { code: 'ExportFailed', message: 'x' },
              result: null,
            },
          ],
        }),
      },
      requests: {
        j: {
          kind: 'export',
          items: [
            { id: 'a', state: {} },
            { id: 'b', state: {} },
          ],
          options: {
            background: 'transparent',
            size: { mode: 'original', width: 0, height: 0, maxSide: null },
            crop: { enabled: true, padding: 3 },
            compression: 6,
            filenameTemplate: 'x',
            folder: '/o',
          },
        },
      },
    });
    vi.mocked(exportPng).mockResolvedValue('j2');
    vi.mocked(getJob).mockResolvedValue(snap({ jobId: 'j2', status: 'running', items: [] }));
    await retryFailed('j');
    const [items, options] = vi.mocked(exportPng).mock.calls[0]!;
    expect(items.map((i) => i.id)).toEqual(['b']);
    expect(options.crop).toEqual({ enabled: true, padding: 3 });
    expect(useQueueStore.getState().dialogJobId).toBe('j2');
  });
});

describe('copy to clipboard', () => {
  it('renders the current image with the given options', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    await copyCurrentToClipboard(DEFAULT_EXPORT_OPTIONS);
    const [item] = vi.mocked(copyToClipboard).mock.calls[0]!;
    expect(item.id).toBe('b');
    expect(lastNotice()).toMatchObject({ kind: 'success', message: 'Copied to the clipboard.' });
  });

  it('reports a clear error when it fails (e.g. no cut-out yet)', async () => {
    vi.mocked(copyToClipboard).mockRejectedValue({
      code: 'ExportFailed',
      message: 'Remove the background first.',
      details: null,
    });
    await copyCurrentToClipboard(DEFAULT_EXPORT_OPTIONS);
    expect(lastNotice()?.kind).toBe('error');
  });
});
