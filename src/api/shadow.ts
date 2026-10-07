import { call } from './invoke';
import type { ExportItemRequest } from './export';
import type { ShadowPreset } from '@/canvas/shadowPresets';

export const listShadowPresets = () => call<ShadowPreset[]>('list_shadow_presets');
export const saveShadowPreset = (preset: Omit<ShadowPreset, 'builtIn'>) =>
  call<ShadowPreset[]>('save_shadow_preset', { preset });
export const deleteShadowPreset = (id: string) =>
  call<ShadowPreset[]>('delete_shadow_preset', { id });

/** Check a shadow against many images as a job (see `shadow_apply_batch`). Returns the job id. */
export const shadowApplyBatch = (items: ExportItemRequest[], label: string) =>
  call<string>('shadow_apply_batch', { items, label });
