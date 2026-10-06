import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PingResponse } from '@/types/dto';
import { call } from './invoke';

export const ping = (message: string) => call<PingResponse>('ping', { message });

/** A `.photom` file the OS launched us with (double-click). Also tells the backend the UI is ready for open-file events. */
export const takeLaunchFile = () => call<string | null>('take_launch_file');

/** A project the OS asked a running Photom to open (second launch, macOS "Open with"). */
export const onOpenFile = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>('app:open-file', (e) => cb(e.payload));
