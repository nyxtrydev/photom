import { setActiveMask } from '@/api/inference';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';
import type { MaskResult } from '@/types/dto';
import { reportError } from './errors';

/** Make an image the active one and show the editor workspace. */
export function openInEditor(id: string) {
  const img = useProjectStore.getState().images.find((i) => i.id === id);
  if (!img) return;
  const ed = useEditorStore.getState();
  ed.ensureState(id, img.width, img.height);
  ed.setActive(id);
  useUiStore.getState().setScreen('edit');
}

/** Switch the active image within the editor. */
export function selectImage(id: string) {
  const img = useProjectStore.getState().images.find((i) => i.id === id);
  if (!img) return;
  const ed = useEditorStore.getState();
  ed.ensureState(id, img.width, img.height);
  ed.setActive(id);
}

export function removeFromProject(id: string) {
  const project = useProjectStore.getState();
  const ed = useEditorStore.getState();
  const remaining = project.images.filter((i) => i.id !== id);
  project.removeImage(id);
  ed.dropState(id);
  if (ed.activeId === id) {
    const next = remaining[0];
    if (next) selectImage(next.id);
    else ed.setActive(null);
  }
}

async function applyMask(id: string, mask: MaskResult | null) {
  try {
    await setActiveMask(id, mask?.maskPath ?? null);
    useProjectStore.getState().setMaskFor(id, mask);
  } catch (e) {
    reportError(e);
  }
}

/** Undo for the active image, including side effects of a model re-run. */
export async function undoActive() {
  const ed = useEditorStore.getState();
  if (!ed.activeId) return;
  const cmd = ed.undo(ed.activeId);
  if (cmd?.type === 'rerun') await applyMask(ed.activeId, cmd.before);
}

export async function redoActive() {
  const ed = useEditorStore.getState();
  if (!ed.activeId) return;
  const cmd = ed.redo(ed.activeId);
  if (cmd?.type === 'rerun') await applyMask(ed.activeId, cmd.after);
}
