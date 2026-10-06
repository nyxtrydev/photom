import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MaskResult, ModelKind, ModelStatus, RemoveOptions } from '@/types/dto';
import { call } from './invoke';

export const removeBackground = (id: string, options: RemoveOptions) =>
  call<MaskResult>('remove_background', { id, options });

export const getModelStatus = (model?: ModelKind) =>
  call<ModelStatus>('get_model_status', { model });

export const onModelStatus = (cb: (s: ModelStatus) => void): Promise<UnlistenFn> =>
  listen<ModelStatus>('model:status', (e) => cb(e.payload));

/** Pass `null` to clear the mask (undo of a first removal run). */
export const setActiveMask = (id: string, maskPath: string | null) =>
  call<void>('set_active_mask', { id, maskPath });
