import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/upscale', () => ({
  upscaleRun: vi.fn(),
  upscaleBatch: vi.fn(),
  upscaleCancel: vi.fn().mockResolvedValue(undefined),
  upscaleAccept: vi.fn(),
  upscaleDiscard: vi.fn().mockResolvedValue(undefined),
  upscaleEstimate: vi.fn(),
  upscaleLoupe: vi.fn(),
  upscaleRequirements: vi.fn(),
}));
vi.mock('./exportActions', () => ({
  jobControl: vi.fn().mockResolvedValue(undefined),
  refreshJob: vi.fn().mockResolvedValue(null),
}));

import {
  upscaleAccept,
  upscaleBatch,
  upscaleCancel,
  upscaleDiscard,
  upscaleRun,
} from '@/api/upscale';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import { useUiStore } from '@/stores/uiStore';
import { defaultOptions, paramsFrom, useUpscaleStore } from '@/stores/upscaleStore';
import type { KeptUpscale } from '@/types/dto';
import type { JobSnapshot } from '@/types/export';
import type { PendingUpscale } from '@/types/upscale';
import { jobControl } from './exportActions';
import {
  cancelUpscale,
  discardResult,
  cancelUpscaleBatch,
  handleUpscaleBatchItem,
  handleUpscaleComplete,
  handleUpscaleFinished,
  retryUpscaleBatch,
  startUpscaleAll,
  keepUpscale,
  revertUpscale,
  startUpscale,
} from './upscaleActions';

const meta = {
  id: 'a',
  path: '/x/a.jpg',
  name: 'a.jpg',
  width: 800,
  height: 600,
  format: 'jpeg',
  thumbnailPath: '',
};
const pending: PendingUpscale = {
  id: 'a',
  path: '/c/pending-1.png',
  width: 1600,
  height: 1200,
  scale: 2,
  engine: 'standard',
};
const kept: KeptUpscale = {
  path: '/c/kept_2x.png',
  width: 1600,
  height: 1200,
  scale: 2,
  engine: 'standard',
};
const run = () => useUpscaleStore.getState().runs['a'];
const notices = () => useUiStore.getState().notices.map((n) => n.message);

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().load({
    name: 'p',
    path: null,
    images: [meta],
    masks: {},
    dirty: false,
  });
  useEditorStore.setState({ states: {}, activeId: null });
  useEditorStore.getState().ensureState('a', 800, 600);
  useEditorStore.getState().setActive('a');
  useUpscaleStore.setState({ options: {}, runs: {} });
  useQueueStore.setState({ jobs: {}, requests: {}, dialogJobId: null, reported: {} });
  useUiStore.setState({ notices: [] });
});

describe('upscale options', () => {
  it('start at 2x Standard with a custom target twice the size', () => {
    expect(defaultOptions({ width: 800, height: 600 })).toEqual({
      scale: 2,
      target: { width: 1600, height: 1200 },
      lockRatio: true,
      engine: 'standard',
      preDenoise: false,
    });
  });

  it('turn into the request the backend expects', () => {
    const o = defaultOptions({ width: 800, height: 600 });
    expect(paramsFrom(o)).toEqual({ scale: 2, engine: 'standard' });
    expect(paramsFrom({ ...o, scale: 4 })).toEqual({ scale: 4, engine: 'standard' });
    expect(paramsFrom({ ...o, scale: 'custom' })).toEqual({
      target: { width: 1600, height: 1200 },
      engine: 'standard',
    });
  });

  it('are remembered per image', () => {
    useUpscaleStore.getState().setOptions('a', meta, { scale: 4 });
    expect(useUpscaleStore.getState().optionsFor('a', meta).scale).toBe(4);
    expect(useUpscaleStore.getState().optionsFor('b', meta).scale).toBe(2);
  });
});

describe('running an upscale', () => {
  it('is marked running before the backend answers, so a fast result cannot be lost', async () => {
    let finish!: (id: string) => void;
    vi.mocked(upscaleRun).mockImplementation(() => new Promise((r) => (finish = r)));
    const p = startUpscale('a');
    expect(run()).toEqual({ phase: 'running', jobId: '' });
    // The result arrives before upscaleRun has even returned.
    useQueueStore.getState().setRequest('j1', { kind: 'upscale', items: [] });
    handleUpscaleComplete(pending);
    expect(run()).toMatchObject({ phase: 'review' });
    finish('j1');
    await p;
  });

  it('sends the chosen options and tracks the job', async () => {
    useUpscaleStore.getState().setOptions('a', meta, { scale: 4 });
    vi.mocked(upscaleRun).mockResolvedValue('j1');
    await startUpscale('a');
    expect(upscaleRun).toHaveBeenCalledWith('a', { scale: 4, engine: 'standard' });
    expect(run()).toEqual({ phase: 'running', jobId: 'j1' });
    expect(useQueueStore.getState().requests['j1']!.kind).toBe('upscale');
  });

  it('does not start a second run while one is going', async () => {
    vi.mocked(upscaleRun).mockResolvedValue('j1');
    await startUpscale('a');
    await startUpscale('a');
    expect(upscaleRun).toHaveBeenCalledTimes(1);
  });

  it('a request the backend refuses shows its reason', async () => {
    vi.mocked(upscaleRun).mockRejectedValue({ code: 'InvalidInput', message: 'Too big.' });
    await startUpscale('a');
    expect(run()).toEqual({ phase: 'error', message: 'Too big.' });
  });

  it('a finished result goes to review, once, even when it is reported twice', () => {
    useUpscaleStore.getState().setRun('a', { phase: 'running', jobId: 'j1' });
    handleUpscaleComplete(pending);
    handleUpscaleComplete(pending); // the event and the final snapshot both say so
    expect(run()).toEqual({ phase: 'review', pending });
    expect(upscaleDiscard).not.toHaveBeenCalled();
  });

  it('junk results are ignored', () => {
    useUpscaleStore.getState().setRun('a', { phase: 'running', jobId: 'j1' });
    handleUpscaleComplete(null);
    handleUpscaleComplete({ nope: 1 });
    expect(run()).toMatchObject({ phase: 'running' });
  });
});

describe('cancelling', () => {
  it('returns to the panel at once, asks the queue to cancel, and drops a late result', async () => {
    useUpscaleStore.getState().setRun('a', { phase: 'running', jobId: 'j1' });
    await cancelUpscale('a');
    expect(run()).toBeUndefined();
    expect(jobControl).toHaveBeenCalledWith('j1', 'cancel');
    expect(upscaleCancel).toHaveBeenCalledWith('a');
    expect(notices().join(' ')).toMatch(/cancelled/);
    // The backend finishes the running item anyway; its result must not appear.
    handleUpscaleComplete(pending);
    expect(run()).toBeUndefined();
    expect(upscaleDiscard).toHaveBeenCalledWith('a', false);
  });

  it('does nothing when nothing is running', async () => {
    await cancelUpscale('a');
    expect(jobControl).not.toHaveBeenCalled();
  });
});

describe('job outcomes', () => {
  const snap = (status: 'done' | 'failed' | 'cancelled', result: unknown = null): JobSnapshot => ({
    jobId: 'j1',
    kind: 'upscale',
    status: 'done',
    done: 1,
    total: 1,
    items: [
      {
        id: 'a',
        label: 'a.jpg',
        status,
        error: status === 'failed' ? { code: 'ExportFailed', message: 'Cannot decode' } : null,
        result,
      },
    ],
  });

  it('an item that failed because it was cancelled is not shown as an error', () => {
    handleUpscaleFinished({
      ...snap('failed'),
      items: [
        {
          id: 'a',
          label: 'a.jpg',
          status: 'failed',
          error: { code: 'Cancelled', message: 'Cancelled' },
          result: null,
        },
      ],
    } as never);
    expect(run()).toBeUndefined();
  });

  it('a failed item becomes an error with the backend’s message', () => {
    useUpscaleStore.getState().setRun('a', { phase: 'running', jobId: 'j1' });
    handleUpscaleFinished(snap('failed'));
    expect(run()).toEqual({ phase: 'error', message: 'Cannot decode' });
  });

  it('a done item whose event was missed still reaches review', () => {
    useUpscaleStore.getState().setRun('a', { phase: 'running', jobId: 'j1' });
    handleUpscaleFinished(snap('done', pending));
    expect(run()).toMatchObject({ phase: 'review' });
  });
});

describe('keep, discard and revert', () => {
  it('Keep stores the version on the image and closes the review', async () => {
    useUpscaleStore.getState().setRun('a', { phase: 'review', pending });
    vi.mocked(upscaleAccept).mockResolvedValue(kept);
    await keepUpscale('a');
    expect(useEditorStore.getState().states['a']!.upscale).toEqual(kept);
    expect(run()).toBeUndefined();
    expect(notices().join(' ')).toMatch(/Kept the upscaled version \(1600 x 1200\)/);
  });

  it('a Keep that fails leaves the review open and says why', async () => {
    useUpscaleStore.getState().setRun('a', { phase: 'review', pending });
    vi.mocked(upscaleAccept).mockRejectedValue({ code: 'InvalidInput', message: 'gone' });
    await keepUpscale('a');
    expect(run()).toMatchObject({ phase: 'review' });
    expect(useEditorStore.getState().states['a']!.upscale).toBeNull();
  });

  it('Discard only drops the result under review; an earlier kept version stays', async () => {
    useEditorStore.getState().setUpscale('a', kept);
    useUpscaleStore.getState().setRun('a', { phase: 'review', pending });
    await discardResult('a');
    expect(upscaleDiscard).toHaveBeenCalledWith('a', false);
    expect(run()).toBeUndefined();
    expect(useEditorStore.getState().states['a']!.upscale).toEqual(kept);
  });

  it('Back to the original removes the kept version', async () => {
    useEditorStore.getState().setUpscale('a', kept);
    await revertUpscale('a');
    expect(upscaleDiscard).toHaveBeenCalledWith('a', true);
    expect(useEditorStore.getState().states['a']!.upscale).toBeNull();
  });

  it('keeping or reverting is not an undo step (it changes a file)', async () => {
    vi.mocked(upscaleAccept).mockResolvedValue(kept);
    useUpscaleStore.getState().setRun('a', { phase: 'review', pending });
    await keepUpscale('a');
    await revertUpscale('a');
    expect(useEditorStore.getState().states['a']!.undo).toHaveLength(0);
  });
});

describe('batch upscaling', () => {
  const second = { ...meta, id: 'b', name: 'b.jpg' };
  const withTwo = () => {
    useProjectStore.getState().load({
      name: 'p',
      path: null,
      images: [meta, second],
      masks: {},
      dirty: false,
    });
    useEditorStore.getState().ensureState('b', 800, 600);
  };

  it('sends every image with the options of the active one and opens the progress dialog', async () => {
    withTwo();
    vi.mocked(upscaleBatch).mockResolvedValue('job1');
    useUpscaleStore.getState().setOptions('a', meta, { scale: 4, preDenoise: true });
    await startUpscaleAll('a');
    expect(upscaleBatch).toHaveBeenCalledWith(['a', 'b'], {
      scale: 4,
      engine: 'standard',
      preDenoise: true,
    });
    const q = useQueueStore.getState();
    expect(q.dialogJobId).toBe('job1');
    expect(q.requests['job1']).toMatchObject({ kind: 'upscaleBatch' });
  });

  it('refuses a custom target size and a single image', async () => {
    withTwo();
    useUpscaleStore.getState().setOptions('a', meta, { scale: 'custom' });
    await startUpscaleAll('a');
    expect(upscaleBatch).not.toHaveBeenCalled();
    expect(notices().join(' ')).toMatch(/target size is for one image/);
    useProjectStore
      .getState()
      .load({ name: 'p', path: null, images: [meta], masks: {}, dirty: false });
    useUpscaleStore.getState().setOptions('a', meta, { scale: 2 });
    await startUpscaleAll('a');
    expect(upscaleBatch).not.toHaveBeenCalled();
  });

  it('a finished image takes its kept version into the editor state', () => {
    handleUpscaleBatchItem({ id: 'a', kept });
    expect(useEditorStore.getState().states['a']?.upscale).toEqual(kept);
    handleUpscaleBatchItem(null);
    handleUpscaleBatchItem({ id: 5 });
    expect(useEditorStore.getState().states['a']?.upscale).toEqual(kept);
  });

  it('retry runs only the failed images with the same settings', async () => {
    withTwo();
    vi.mocked(upscaleBatch).mockResolvedValueOnce('job1').mockResolvedValueOnce('job2');
    await startUpscaleAll('a');
    useQueueStore.getState().setSnapshot({
      jobId: 'job1',
      kind: 'upscaleBatch',
      status: 'done',
      done: 2,
      total: 2,
      items: [
        { id: 'a', label: 'a', status: 'done', error: null, result: null },
        {
          id: 'b',
          label: 'b',
          status: 'failed',
          error: { code: 'Decode', message: 'x' },
          result: null,
        },
      ],
    } as JobSnapshot);
    await retryUpscaleBatch('job1');
    expect(upscaleBatch).toHaveBeenLastCalledWith(['b'], { scale: 2, engine: 'standard' });
    expect(useQueueStore.getState().dialogJobId).toBe('job2');
  });

  it('cancelling asks the backend to stop each image at its next tile', () => {
    cancelUpscaleBatch(['a', 'b']);
    expect(upscaleCancel).toHaveBeenCalledWith('a');
    expect(upscaleCancel).toHaveBeenCalledWith('b');
  });
});
