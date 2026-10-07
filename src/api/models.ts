import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  CatalogStatus,
  ModelErrorEvent,
  ModelInfo,
  ModelProgress,
  ModelStateEvent,
  RefreshResult,
} from '@/types/models';
import { call } from './invoke';

export const listModels = () => call<ModelInfo[]>('models_list');
export const catalogStatus = () => call<CatalogStatus>('model_catalog_status');
export const refreshCatalog = () => call<RefreshResult>('models_refresh_catalog');
export const installModel = (id: string) => call<void>('model_install', { id });
export const installModels = (ids: string[]) => call<number>('model_install_many', { ids });
export const installRecommended = () => call<number>('model_install_recommended');
export const installAll = () => call<number>('model_install_all');
export const pauseModel = (id: string) => call<void>('model_pause', { id });
export const resumeModel = (id: string) => call<void>('model_resume', { id });
export const cancelModel = (id: string) => call<void>('model_cancel', { id });
export const importModelFile = (id: string, path: string, allowUnverified: boolean) =>
  call<void>('model_import_file', { id, path, allowUnverified });
export const removeModel = (id: string) => call<void>('model_remove', { id });
export const openModelsFolder = () => call<void>('model_open_folder');

export const onModelState = (cb: (e: ModelStateEvent) => void): Promise<UnlistenFn> =>
  listen<ModelStateEvent>('model:state', (e) => cb(e.payload));
export const onModelProgress = (cb: (e: ModelProgress) => void): Promise<UnlistenFn> =>
  listen<ModelProgress>('model:progress', (e) => cb(e.payload));
export const onModelError = (cb: (e: ModelErrorEvent) => void): Promise<UnlistenFn> =>
  listen<ModelErrorEvent>('model:error', (e) => cb(e.payload));
export const onCatalogUpdated = (cb: () => void): Promise<UnlistenFn> =>
  listen('catalog:updated', () => cb());
