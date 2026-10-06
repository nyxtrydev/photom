import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';

vi.mock('@/api/image', () => ({ importImages: vi.fn() }));
vi.mock('@/api/inference', () => ({ removeBackground: vi.fn() }));

import { importImages } from '@/api/image';
import { removeBackground as removeBackgroundApi } from '@/api/inference';
import { importPaths, removeBackground } from './actions';

const meta = (id: string) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: 10,
  height: 5,
  format: 'jpeg',
  thumbnailPath: `/t/${id}.png`,
});

beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.getState().clearImages();
  useUiStore.setState({ notices: [] });
});

describe('importPaths', () => {
  it('adds accepted images (deduplicated) and warns for rejected files', async () => {
    vi.mocked(importImages).mockResolvedValue({
      images: [meta('a')],
      rejected: [{ path: '/x/notes.txt', reason: 'Unsupported file type.' }],
    });
    await importPaths(['/x/a.jpg', '/x/notes.txt']);
    await importPaths(['/x/a.jpg']);
    expect(useProjectStore.getState().images).toHaveLength(1);
    const warnings = useUiStore.getState().notices.filter((n) => n.kind === 'warning');
    expect(warnings[0]?.message).toBe('Could not import notes.txt');
  });

  it('turns a backend error into an error notice', async () => {
    vi.mocked(importImages).mockRejectedValue({ code: 'Io', message: 'disk', details: 'disk' });
    await importPaths(['/x/a.jpg']);
    expect(useUiStore.getState().notices[0]?.kind).toBe('error');
  });

  it('ignores an empty selection (cancelled dialog)', async () => {
    await importPaths([]);
    expect(importImages).not.toHaveBeenCalled();
  });
});

describe('removeBackground', () => {
  it('stores the mask and clears the processing flag', async () => {
    vi.mocked(removeBackgroundApi).mockResolvedValue({
      id: 'a',
      maskPath: '/m/a.png',
      width: 10,
      height: 5,
      boundingBox: null,
      durationMs: 1200,
      device: 'cpu',
    });
    await removeBackground('a');
    const s = useProjectStore.getState();
    expect(s.masks['a']?.maskPath).toBe('/m/a.png');
    expect(s.processing['a']).toBe(false);
  });

  it('reports ModelMissing as an error notice and recovers', async () => {
    vi.mocked(removeBackgroundApi).mockRejectedValue({
      code: 'ModelMissing',
      message: 'x',
      details: 'x',
    });
    await removeBackground('a');
    expect(useUiStore.getState().notices[0]?.message).toBe(
      'The background removal model is missing.',
    );
    expect(useProjectStore.getState().processing['a']).toBe(false);
  });
});
