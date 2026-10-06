import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '@/api/window';

/** Local file -> URL the webview can display (asset protocol). Plain path outside Tauri (tests). */
export const assetUrl = (path: string) => (isTauri() ? convertFileSrc(path) : path);
