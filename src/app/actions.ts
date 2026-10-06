import { importImages } from '@/api/image';
import { removeBackground as removeBackgroundApi } from '@/api/inference';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { ImageMeta } from '@/types/dto';
import { openInEditor } from './editorActions';
import { reportError } from './errors';

export interface ImportOptions {
  recursive?: boolean;
  /** Jump to the editor with the first imported image (used from Home). */
  openEditor?: boolean;
}

/** Import files/folders and surface per-file rejections as notices. */
export async function importPaths(
  paths: string[],
  options: ImportOptions = {},
): Promise<ImageMeta[]> {
  if (paths.length === 0) return [];
  const { notify } = useUiStore.getState();
  try {
    const res = await importImages(paths, options.recursive ?? false);
    useProjectStore.getState().addImages(res.images);
    for (const r of res.rejected) {
      const file = r.path.split(/[\\/]/).pop() ?? r.path;
      notify('warning', strings.import.rejected(file), r.reason);
    }
    if (res.images.length === 0 && res.rejected.length === 0) {
      notify('info', strings.import.nothingFound);
    }
    const first = res.images[0];
    if (first && options.openEditor) openInEditor(first.id);
    return res.images;
  } catch (e) {
    reportError(e);
    return [];
  }
}

/** Run background removal for one image using the current settings (undoable in the editor). */
export async function removeBackground(id: string) {
  const project = useProjectStore.getState();
  const { modelType, processing } = useSettingsStore.getState();
  if (project.processing[id]) return;
  const previous = project.masks[id] ?? null;
  project.setProcessing(id, true);
  try {
    const result = await removeBackgroundApi(id, { model: modelType, device: processing });
    project.setMask(result);
    const img = project.images.find((i) => i.id === id);
    const ed = useEditorStore.getState();
    if (img) ed.ensureState(id, img.width, img.height);
    ed.recordRerun(id, previous, result);
  } catch (e) {
    reportError(e);
  } finally {
    useProjectStore.getState().setProcessing(id, false);
  }
}
