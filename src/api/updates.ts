import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { call } from './invoke';

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string | null;
  notes: string | null;
  date: string | null;
}

export const checkForUpdate = () => call<UpdateInfo>('check_for_update');
export const installUpdate = () => call<void>('install_update');
export const restartApp = () => call<void>('restart_app');

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}
export const onUpdateProgress = (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>('update:progress', (e) => cb(e.payload));
