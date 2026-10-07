import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/models', () => ({
  installModels: vi.fn().mockResolvedValue(1),
  pauseModel: vi.fn().mockResolvedValue(undefined),
  resumeModel: vi.fn().mockResolvedValue(undefined),
  cancelModel: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@/api/models';
import { useHubStore } from '@/stores/hubStore';
import { model, seedHub, withState } from '@/test/hubFixtures';
import { useModelRequirement } from './useModelRequirement';

const feature = { feature: 'text-removal' };
const pair = () => [model('det', { sizeBytes: 60 }), model('fill', { sizeBytes: 140 })];

describe('useModelRequirement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is ready until the list has loaded, so panels never flash locked', () => {
    useHubStore.setState({ models: {}, order: [], loaded: false });
    const { result } = renderHook(() => useModelRequirement(feature));
    expect(result.current.ready).toBe(true);
    expect(result.current.phase).toBe('ready');
  });

  it('reports what is missing and its total size', () => {
    seedHub(pair());
    const { result } = renderHook(() => useModelRequirement(feature));
    expect(result.current.ready).toBe(false);
    expect(result.current.phase).toBe('idle');
    expect(result.current.missing.map((m) => m.id)).toEqual(['det', 'fill']);
    expect(result.current.missingBytes).toBe(200);
  });

  it('unlocks the moment the last model is installed', () => {
    seedHub(pair());
    const { result } = renderHook(() => useModelRequirement(feature));
    act(() => useHubStore.getState().setState('det', withState('installed')));
    expect(result.current.missing.map((m) => m.id)).toEqual(['fill']);
    expect(result.current.ready).toBe(false);
    act(() => useHubStore.getState().setState('fill', withState('installed')));
    expect(result.current.ready).toBe(true);
  });

  it('an update available still counts as ready', () => {
    seedHub(pair().map((m) => ({ ...m, state: withState('updateAvailable') })));
    const { result } = renderHook(() => useModelRequirement(feature));
    expect(result.current.ready).toBe(true);
  });

  it('prefers failed over working over paused over unavailable over idle', () => {
    const phase = (states: Parameters<typeof withState>[0][], extra = {}) => {
      seedHub(states.map((k, i) => model(`m${i}`, { state: withState(k), ...extra })));
      return renderHook(() => useModelRequirement({ models: states.map((_, i) => `m${i}`) })).result
        .current.phase;
    };
    expect(phase(['failed', 'downloading'])).toBe('failed');
    expect(phase(['paused', 'downloading'])).toBe('working');
    expect(phase(['paused', 'notInstalled'])).toBe('paused');
    expect(phase(['notInstalled', 'notInstalled'], { installable: false })).toBe('unavailable');
    expect(phase(['notInstalled', 'installed'])).toBe('idle');
  });

  it('sums progress over every required model, so the bar never jumps back', () => {
    seedHub([
      model('det', { sizeBytes: 100, state: withState('installed') }),
      model('fill', { sizeBytes: 300, state: withState('downloading') }),
    ]);
    act(() =>
      useHubStore.getState().setProgress({
        id: 'fill',
        downloadedBytes: 100,
        totalBytes: 300,
        speedBps: 50,
        etaSeconds: 4,
      }),
    );
    const { result } = renderHook(() => useModelRequirement({ models: ['det', 'fill'] }));
    // 100 (already installed) + 100 of 300 = 200 of 400.
    expect(result.current.progress).toMatchObject({
      downloadedBytes: 200,
      totalBytes: 400,
      percent: 50,
      speedBps: 50,
      etaSeconds: 4,
    });
  });

  it('install only asks for models that can be downloaded and are not busy', async () => {
    seedHub([
      model('a'),
      model('b', { installable: false }),
      model('c', { state: withState('downloading') }),
      model('d', { state: withState('paused') }),
      model('e', { state: withState('failed') }),
    ]);
    const { result } = renderHook(() => useModelRequirement({ models: ['a', 'b', 'c', 'd', 'e'] }));
    await act(() => result.current.install());
    expect(api.installModels).toHaveBeenCalledWith(['a', 'd', 'e']);
  });

  it('pause, resume and cancel act on the right models', async () => {
    seedHub([
      model('a', { state: withState('downloading') }),
      model('b', { state: withState('queued') }),
      model('c', { state: withState('paused') }),
    ]);
    const { result } = renderHook(() => useModelRequirement({ models: ['a', 'b', 'c'] }));
    await act(() => result.current.pause());
    expect(vi.mocked(api.pauseModel).mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    await act(() => result.current.resume());
    expect(vi.mocked(api.resumeModel).mock.calls.map((c) => c[0])).toEqual(['c']);
    await act(() => result.current.cancel());
    expect(vi.mocked(api.cancelModel).mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('unknown explicit ids do not make a feature look missing', () => {
    seedHub(pair());
    const { result } = renderHook(() => useModelRequirement({ models: ['nope'] }));
    expect(result.current.ready).toBe(true);
  });
});
