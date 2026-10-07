import { pickProject, pickProjectSavePath } from '@/api/dialogs';
import { toAppError } from '@/api/invoke';
import {
  discardRecovery,
  openProject as openProjectApi,
  projectBackupPath,
  restoreRecovery,
  resetSession,
  saveProject as saveProjectApi,
} from '@/api/project';
import { getSettings } from '@/api/settings';
import { strings } from '@/i18n/strings';
import { useEditorStore, type ImageEditState } from '@/stores/editorStore';
import { fromPersisted, toPersisted } from '@/stores/persist';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { MaskResult, OpenedProject, ProjectPayload } from '@/types/dto';
import { ask } from './confirm';
import { reportError } from './errors';

const baseName = (path: string) => {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.photom$/i, '');
};

/** Display title for the title bar, e.g. `dog.photom *`. */
export function projectTitle(name: string, path: string | null, dirty: boolean) {
  const label = path ? `${baseName(path)}.photom` : `${name}.photom`;
  return `${label}${dirty ? ' *' : ''}`;
}

export function buildPayload(): ProjectPayload {
  const project = useProjectStore.getState();
  const ed = useEditorStore.getState();
  return {
    projectId: project.projectId,
    name: project.name,
    activeId: ed.activeId,
    originalPath: project.path,
    images: project.images.map((img) => {
      const state = ed.states[img.id];
      return {
        id: img.id,
        state: state ? toPersisted(state) : {},
        backgroundSource: state?.background.image?.sourcePath ?? null,
      };
    }),
  };
}

async function refreshSettings() {
  try {
    useSettingsStore.getState().apply(await getSettings());
  } catch {
    /* non-fatal */
  }
}

/** Replace the current project with an opened/restored one. */
export function hydrate(opened: OpenedProject, path: string | null, dirty: boolean) {
  const states: Record<string, ImageEditState> = {};
  const masks: Record<string, MaskResult> = {};
  for (const img of opened.images) {
    states[img.meta.id] = {
      ...fromPersisted(img.state, img.meta.width, img.meta.height),
      // The file is the truth: a state.json entry without its picture is ignored.
      upscale: img.upscaled ?? null,
    };
    if (img.mask) masks[img.meta.id] = img.mask;
  }
  const ids = opened.images.map((i) => i.meta.id);
  const active =
    opened.meta.activeId && ids.includes(opened.meta.activeId)
      ? opened.meta.activeId
      : (ids[0] ?? null);

  useEditorStore.getState().replaceAll(states, active);
  useProjectStore.getState().load({
    projectId: opened.meta.projectId,
    name: path ? baseName(path) : opened.meta.name,
    path,
    images: opened.images.map((i) => i.meta),
    masks,
    dirty,
  });
  useUiStore.getState().setLastAutosave(null);
  useUiStore.getState().setScreen(ids.length > 0 ? 'edit' : 'home');
  for (const w of opened.warnings) useUiStore.getState().notify('warning', w);
}

/** Ask what to do with unsaved changes. Resolves true when it is safe to continue. */
export async function confirmDiscardChanges(): Promise<boolean> {
  const { dirty, name, path } = useProjectStore.getState();
  if (!dirty) return true;
  const choice = await ask({
    title: strings.project.unsavedTitle,
    message: strings.project.unsavedMessage(path ? baseName(path) : name),
    cancelId: 'cancel',
    buttons: [
      { id: 'save', label: strings.project.save, tone: 'primary' },
      { id: 'discard', label: strings.project.dontSave, tone: 'danger' },
      { id: 'cancel', label: strings.project.cancel },
    ],
  });
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveProject();
  return true;
}

async function doSave(path: string): Promise<boolean> {
  try {
    const meta = await saveProjectApi({ ...buildPayload(), originalPath: path }, path);
    const savedPath = meta.path ?? path;
    useProjectStore.getState().setSaved(baseName(savedPath), savedPath);
    useUiStore.getState().setLastAutosave(null);
    useUiStore.getState().notify('success', strings.project.saved(baseName(savedPath)));
    void refreshSettings();
    return true;
  } catch (e) {
    reportError(e);
    return false;
  }
}

export async function saveProjectAs(): Promise<boolean> {
  const { name, images } = useProjectStore.getState();
  if (images.length === 0) {
    useUiStore.getState().notify('info', strings.project.nothingToSave);
    return false;
  }
  const chosen = await pickProjectSavePath(`${name}.photom`);
  return chosen ? doSave(chosen) : false;
}

export async function saveProject(): Promise<boolean> {
  const { path, images } = useProjectStore.getState();
  if (images.length === 0) {
    useUiStore.getState().notify('info', strings.project.nothingToSave);
    return false;
  }
  return path ? doSave(path) : saveProjectAs();
}

/** Forget the autosave of the project that is being replaced. */
async function dropAutosave(projectId: string) {
  try {
    await discardRecovery(projectId);
  } catch {
    /* nothing to discard */
  }
}

export async function newProject() {
  if (!(await confirmDiscardChanges())) return;
  const old = useProjectStore.getState().projectId;
  try {
    await resetSession();
  } catch (e) {
    reportError(e);
    return;
  }
  await dropAutosave(old);
  useEditorStore.getState().replaceAll({}, null);
  useProjectStore
    .getState()
    .load({ name: 'Untitled', path: null, images: [], masks: {}, dirty: false });
  useUiStore.getState().setLastAutosave(null);
  useUiStore.getState().setScreen('home');
}

/** Open a project file (asks for unsaved changes first; offers the `.bak` if the file is damaged). */
export async function openProject(path?: string) {
  if (!(await confirmDiscardChanges())) return;
  const target = path ?? (await pickProject());
  if (target) await openProjectPath(target);
}

async function openProjectPath(path: string) {
  const old = useProjectStore.getState().projectId;
  try {
    const opened = await openProjectApi(path);
    await dropAutosave(old);
    hydrate(opened, path, false);
  } catch (e) {
    const err = toAppError(e);
    if (err.code === 'ProjectCorrupt') {
      const backup = await projectBackupPath(path).catch(() => null);
      if (backup) {
        const choice = await ask({
          title: strings.project.corruptTitle,
          message: strings.project.corruptWithBackup(err.message),
          cancelId: 'cancel',
          buttons: [
            { id: 'backup', label: strings.project.openBackup, tone: 'primary' },
            { id: 'cancel', label: strings.project.cancel },
          ],
        });
        if (choice === 'backup') {
          try {
            hydrate(await openProjectApi(backup), null, true);
          } catch (e2) {
            reportError(e2);
          }
        }
        return;
      }
      await ask({
        title: strings.project.corruptTitle,
        message: strings.project.corrupt(err.message),
        cancelId: 'ok',
        buttons: [{ id: 'ok', label: strings.project.ok, tone: 'primary' }],
      });
      return;
    }
    reportError(e);
  }
}

export async function restoreRecoveryEntry(id: string) {
  try {
    const opened = await restoreRecovery(id);
    hydrate(opened, opened.meta.path, true);
    useUiStore.getState().setRecovery(useUiStore.getState().recovery.filter((r) => r.id !== id));
  } catch (e) {
    reportError(e);
  }
}

export async function discardRecoveryEntry(id: string, confirm = true) {
  if (confirm) {
    const choice = await ask({
      title: strings.project.discardTitle,
      message: strings.project.discardMessage,
      cancelId: 'cancel',
      buttons: [
        { id: 'discard', label: strings.project.discard, tone: 'danger' },
        { id: 'cancel', label: strings.project.keep },
      ],
    });
    if (choice !== 'discard') return;
  }
  try {
    await discardRecovery(id);
  } finally {
    useUiStore.getState().setRecovery(useUiStore.getState().recovery.filter((r) => r.id !== id));
  }
}
