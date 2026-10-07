import type { KeptUpscale } from '@/types/dto';
import type { PendingUpscale, UpscaleEstimate, UpscaleParams } from '@/types/upscale';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { call, callBinary } from './invoke';

export const upscaleEstimate = (imageId: string, params: UpscaleParams) =>
  call<UpscaleEstimate>('upscale_estimate', { imageId, params });

/** Start an upscale job; the result arrives as `job:item-complete`. Returns the job id. */
export const upscaleRun = (imageId: string, params: UpscaleParams) =>
  call<string>('upscale_run', { imageId, params });

export const upscaleAccept = (imageId: string) => call<KeptUpscale>('upscale_accept', { imageId });
/** Drop the waiting result; with `includeKept` also the kept version (back to the original). */
export const upscaleDiscard = (imageId: string, includeKept = false) =>
  call<void>('upscale_discard', { imageId, includeKept });

/** Which models a scale needs. The panel normally reads this from the Model Hub store instead. */
export const upscaleRequirements = (scale: 2 | 4) =>
  call<{ ready: boolean; missing: { id: string }[] }>('upscale_requirements', { scale });

/** PNG of the original (enlarged) beside the result, `size * 2` wide, centred on (x, y). */
export const upscaleLoupe = (imageId: string, x: number, y: number, size: number) =>
  callBinary('upscale_loupe', { imageId, at: { x, y, size } });

export type { PendingUpscale };

/** Stop a running AI upscale at the next tile. */
export const upscaleCancel = (imageId: string) => call<void>('upscale_cancel', { imageId });

export interface UpscaleTileProgress {
  id: string;
  done: number;
  total: number;
}
export const onUpscaleProgress = (cb: (p: UpscaleTileProgress) => void): Promise<UnlistenFn> =>
  listen<UpscaleTileProgress>('upscale:progress', (e) => cb(e.payload));

/** Upscale several images by the same scale and keep every result. Returns the job id. */
export const upscaleBatch = (imageIds: string[], params: UpscaleParams) =>
  call<string>('upscale_batch', { imageIds, params });
