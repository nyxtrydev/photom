import { beforeEach, describe, expect, it } from 'vitest';
import { model, seedHub, withState } from '@/test/hubFixtures';
import { isActive, isUsable, requiredFor, useHubStore } from './hubStore';

const progress = (id: string, n = 10) => ({
  id,
  downloadedBytes: n,
  totalBytes: 100,
  speedBps: 1,
  etaSeconds: 1,
});

describe('hubStore', () => {
  beforeEach(() => seedHub([]));

  it('updates one model state and ignores unknown ids', () => {
    seedHub([model('a'), model('b')]);
    useHubStore.getState().setState('a', withState('queued'));
    useHubStore.getState().setState('zzz', withState('queued'));
    expect(useHubStore.getState().models['a']?.state.kind).toBe('queued');
    expect(useHubStore.getState().models['b']?.state.kind).toBe('notInstalled');
    expect(Object.keys(useHubStore.getState().models)).toEqual(['a', 'b']);
  });

  it('drops progress when a download ends, but keeps it while paused', () => {
    seedHub([model('a')]);
    const s = useHubStore.getState();
    s.setProgress(progress('a'));
    s.setState('a', withState('paused'));
    expect(useHubStore.getState().progress['a']).toBeDefined();
    for (const kind of ['installed', 'notInstalled', 'failed'] as const) {
      useHubStore.getState().setProgress(progress('a'));
      useHubStore.getState().setState('a', withState(kind));
      expect(useHubStore.getState().progress['a'], kind).toBeUndefined();
    }
  });

  it('replacing the list keeps progress only for models still being fetched', () => {
    seedHub([model('a'), model('b'), model('c')]);
    useHubStore.getState().setProgress(progress('a'));
    useHubStore.getState().setProgress(progress('b'));
    useHubStore.getState().setProgress(progress('c'));
    useHubStore
      .getState()
      .setModels([
        model('a', { state: withState('downloading') }),
        model('b', { state: withState('paused') }),
        model('c', { state: withState('installed') }),
      ]);
    expect(Object.keys(useHubStore.getState().progress).sort()).toEqual(['a', 'b']);
  });

  it('classifies states', () => {
    expect(
      ['queued', 'downloading', 'verifying', 'installing'].every((k) => isActive(k as never)),
    ).toBe(true);
    expect(
      ['paused', 'installed', 'failed', 'notInstalled'].some((k) => isActive(k as never)),
    ).toBe(false);
    expect(isUsable(model('a', { state: withState('installed') }))).toBe(true);
    expect(isUsable(model('a', { state: withState('updateAvailable') }))).toBe(true);
    expect(isUsable(model('a', { state: withState('downloading') }))).toBe(false);
  });

  it('requiredFor mirrors the backend rule: recommended models plus their dependencies', () => {
    seedHub([
      model('main', { feature: 'x', dependsOn: ['dep'] }),
      model('dep', { feature: 'other', recommended: false }),
      model('optional', { feature: 'x', recommended: false }),
      model('cycle-a', { feature: 'y', dependsOn: ['cycle-b'] }),
      model('cycle-b', { feature: 'y', dependsOn: ['cycle-a'] }),
    ]);
    const { models } = useHubStore.getState();
    expect(requiredFor(models, 'x').map((m) => m.id)).toEqual(['main', 'dep']);
    expect(
      requiredFor(models, 'y')
        .map((m) => m.id)
        .sort(),
    ).toEqual(['cycle-a', 'cycle-b']);
    expect(requiredFor(models, 'unknown')).toEqual([]);
  });
});
