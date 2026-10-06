import { getCurrentWindow } from '@tauri-apps/api/window';

/** True when running inside the Tauri webview (false in plain browser / tests). */
export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const windowApi = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onResized: (cb: () => void) => getCurrentWindow().onResized(cb),
  /** `handler` may call `event.preventDefault()` to veto the close. */
  onCloseRequested: (handler: (event: { preventDefault: () => void }) => void | Promise<void>) =>
    getCurrentWindow().onCloseRequested(handler),
  destroy: () => getCurrentWindow().destroy(),
};
