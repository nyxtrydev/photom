import { useEffect, useState } from 'react';
import { subscribeDragDrop } from '@/api/dragdrop';
import { isTauri } from '@/api/window';
import { importPaths } from '@/app/actions';
import { selectImage } from '@/app/editorActions';
import { openProject } from '@/app/projectActions';
import { useUiStore } from '@/stores/uiStore';

/** Window-wide OS file drop. Returns whether a drag is currently hovering the window. */
/** `openEditor` = jump to the full editor after a drop (default); pass false to stay on the current screen. */
async function handleDrop(paths: string[], openEditor: boolean) {
  const images = await importPaths(paths, {
    openEditor: openEditor && useUiStore.getState().screen !== 'edit',
  });
  // In the quick flow the dropped image becomes the one shown.
  if (!openEditor && images[0]) selectImage(images[0].id);
}

export function useFileDrop(openEditor = true): boolean {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void subscribeDragDrop({
      onHover: setHovering,
      onDrop: (paths) => {
        const project = paths.find((p) => p.toLowerCase().endsWith('.photom'));
        if (project) void openProject(project);
        else void handleDrop(paths, openEditor);
      },
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openEditor]);
  return hovering;
}
