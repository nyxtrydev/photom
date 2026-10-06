import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { OpenedProject, RemoveOptions } from '@/types/dto';
import type {
  ExportOptionsApi,
  ExportPreset,
  HistoryItem,
  JobEventBase,
  JobItemComplete,
  JobSnapshot,
} from '@/types/export';
import { call } from './invoke';

export interface ExportItemRequest {
  id: string;
  /** Persisted editor state of the image (refine, strokes, background, ...). */
  state: unknown;
}

export const exportPng = (items: ExportItemRequest[], options: ExportOptionsApi) =>
  call<string>('export_png', { items, options });

export const removeBackgroundBatch = (ids: string[], options: RemoveOptions) =>
  call<string>('remove_background_batch', { ids, options });

export const cancelJob = (jobId: string) => call<void>('cancel_job', { jobId });
export const pauseJob = (jobId: string) => call<void>('pause_job', { jobId });
export const resumeJob = (jobId: string) => call<void>('resume_job', { jobId });
export const getJob = (jobId: string) => call<JobSnapshot>('get_job', { jobId });

export const copyToClipboard = (item: ExportItemRequest, options: ExportOptionsApi) =>
  call<void>('copy_to_clipboard', { item, options });

export const listHistory = () => call<HistoryItem[]>('list_history');
export const deleteHistoryItem = (id: string) => call<HistoryItem[]>('delete_history_item', { id });
export const clearHistory = () => call<HistoryItem[]>('clear_history');

export const listExportPresets = () => call<ExportPreset[]>('list_export_presets');
export const saveExportPreset = (preset: Omit<ExportPreset, 'builtIn'> | ExportPreset) =>
  call<ExportPreset[]>('save_export_preset', { preset });
export const deleteExportPreset = (id: string) =>
  call<ExportPreset[]>('delete_export_preset', { id });

type Handler<T> = (payload: T) => void;
export const onJobProgress = (cb: Handler<JobEventBase>): Promise<UnlistenFn> =>
  listen<JobEventBase>('job:progress', (e) => cb(e.payload));
export const onJobItemComplete = (cb: Handler<JobItemComplete>): Promise<UnlistenFn> =>
  listen<JobItemComplete>('job:item-complete', (e) => cb(e.payload));
export const onJobError = (cb: Handler<JobEventBase>): Promise<UnlistenFn> =>
  listen<JobEventBase>('job:error', (e) => cb(e.payload));

export type { OpenedProject };
