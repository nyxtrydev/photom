import { getCurrentWebview } from '@tauri-apps/api/webview';

export interface DragDropHandlers {
  onHover: (hovering: boolean) => void;
  onDrop: (paths: string[]) => void;
}

/** Subscribes to OS file drag & drop on the window. Returns an unsubscribe function. */
export async function subscribeDragDrop({ onHover, onDrop }: DragDropHandlers) {
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === 'enter' || p.type === 'over') onHover(true);
    else if (p.type === 'leave') onHover(false);
    else if (p.type === 'drop') {
      onHover(false);
      onDrop(p.paths);
    }
  });
}
