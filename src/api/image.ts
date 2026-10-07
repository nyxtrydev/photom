import type { BackgroundImage, ImportResult, WorkingSet } from '@/types/dto';
import { call, callBinary } from './invoke';

export const importImages = (paths: string[], recursive = false) =>
  call<ImportResult>('import_images', { paths, recursive });

export const getThumbnail = (id: string) => call<string>('get_thumbnail', { id });

export const prepareWorkingSet = (id: string, maxSide?: number) =>
  call<WorkingSet>('prepare_working_set', { id, maxSide });

export const prepareBackgroundImage = (path: string) =>
  call<BackgroundImage>('prepare_background_image', { path });

export const revealInFolder = (id: string) => call<void>('reveal_in_folder', { id });

/** Decode a cache file (preview, mask, background) into an ImageBitmap via binary IPC. */
export async function loadCacheBitmap(path: string): Promise<ImageBitmap> {
  const bytes = await callBinary('read_cache_file', { path });
  return createImageBitmap(new Blob([bytes]));
}

/** Like `loadCacheBitmap`, but decoded straight to at most `maxSide` pixels (big upscaled results). */
export async function loadCacheBitmapScaled(path: string, maxSide: number): Promise<ImageBitmap> {
  const bytes = await callBinary('read_cache_file', { path });
  const blob = new Blob([bytes]);
  const full = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(full.width, full.height));
  if (k >= 1) return full;
  const small = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * k)),
    resizeHeight: Math.max(1, Math.round(full.height * k)),
    resizeQuality: 'high',
  });
  full.close();
  return small;
}
