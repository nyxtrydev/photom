import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/models', () => ({
  listModels: vi.fn(),
  catalogStatus: vi.fn().mockResolvedValue({
    source: 'bundled',
    generatedAt: '2026-01-01T00:00:00Z',
    warning: null,
  }),
}));

import * as api from '@/api/models';
import { handleModelState, registerFeatureOpener } from '@/app/modelActions';
import { useHubStore } from '@/stores/hubStore';
import { useUiStore } from '@/stores/uiStore';
import { model, seedHub, withState } from '@/test/hubFixtures';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('handleModelState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ notices: [] });
  });

  it('updates the store and says nothing for intermediate states', () => {
    seedHub([model('a')]);
    handleModelState('a', withState('downloading'));
    expect(useHubStore.getState().models['a']?.state.kind).toBe('downloading');
    expect(useUiStore.getState().notices).toHaveLength(0);
  });

  it('announces a feature once all of its models are installed, with an Open action', async () => {
    const done = [model('text-detector'), model('inpaint-lama')];
    seedHub(done.map((m) => ({ ...m, state: withState('downloading') })));
    const open = vi.fn();
    registerFeatureOpener('text-removal', open);

    vi.mocked(api.listModels).mockResolvedValue([
      { ...done[0]!, state: withState('installed') },
      { ...done[1]!, state: withState('downloading') },
    ]);
    handleModelState('text-detector', withState('installed'));
    await flush();
    expect(useUiStore.getState().notices).toHaveLength(0);

    vi.mocked(api.listModels).mockResolvedValue(
      done.map((m) => ({ ...m, state: withState('installed') })),
    );
    handleModelState('inpaint-lama', withState('installed'));
    await flush();
    const [notice] = useUiStore.getState().notices;
    expect(notice?.message).toBe('Text Removal is ready');
    notice?.actions?.[0]?.onClick();
    expect(open).toHaveBeenCalled();
  });

  it('does not announce models that were already installed', async () => {
    seedHub([model('a', { state: withState('installed') })]);
    vi.mocked(api.listModels).mockResolvedValue([model('a', { state: withState('installed') })]);
    handleModelState('a', withState('installed'));
    await flush();
    expect(useUiStore.getState().notices).toHaveLength(0);
  });

  it('names the model when it is optional for its feature', async () => {
    const optional = model('upscale-x4-anime', {
      feature: 'upscale',
      recommended: false,
      name: 'Anime x4',
    });
    seedHub([{ ...optional, state: withState('downloading') }]);
    vi.mocked(api.listModels).mockResolvedValue([{ ...optional, state: withState('installed') }]);
    handleModelState('upscale-x4-anime', withState('installed'));
    await flush();
    expect(useUiStore.getState().notices[0]?.message).toBe('Anime x4 is ready');
  });
});
