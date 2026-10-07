import { useHubStore } from '@/stores/hubStore';
import type { ModelInfo, ModelState } from '@/types/models';

export function model(id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    feature: 'text-removal',
    version: '1.0.0',
    description: `About ${id}`,
    sizeBytes: 70_000_000,
    sha256: 'ab'.repeat(32),
    license: {
      name: 'Apache-2.0',
      url: 'https://example.org/licence',
      commercialUse: true,
      attribution: 'By Someone',
    },
    requirements: { minRamMb: 2048, gpuOptional: true },
    recommended: true,
    dependsOn: [],
    state: { kind: 'notInstalled' },
    installedVersion: null,
    source: null,
    verified: false,
    installable: true,
    removable: false,
    ...over,
  };
}

export const withState = (kind: ModelState['kind']): ModelState =>
  kind === 'failed' ? { kind, code: 'Network', message: 'x' } : ({ kind } as ModelState);

export function seedHub(models: ModelInfo[]) {
  useHubStore.setState({
    models: Object.fromEntries(models.map((m) => [m.id, m])),
    order: models.map((m) => m.id),
    progress: {},
    loaded: true,
    catalog: { source: 'bundled', generatedAt: '2026-01-01T00:00:00Z', warning: null },
  });
}
