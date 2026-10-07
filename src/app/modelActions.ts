import { pickModelFile } from '@/api/dialogs';
import * as api from '@/api/models';
import { ask } from '@/app/confirm';
import { reportError } from '@/app/errors';
import { toAppError } from '@/api/invoke';
import { strings } from '@/i18n/strings';
import { isActive, isUsable, requiredFor, useHubStore } from '@/stores/hubStore';
import { useUiStore } from '@/stores/uiStore';
import type { ModelInfo, ModelState } from '@/types/models';

const t = strings.models;

/** Where "Open" in the "... is ready" toast goes. Feature screens register themselves here. */
const openers: Record<string, () => void> = {
  'background-removal': () => useUiStore.getState().openSettings('model'),
};

export function registerFeatureOpener(feature: string, open: () => void) {
  openers[feature] = open;
}

export const featureLabel = (feature: string) => t.features[feature] ?? feature;

export async function refreshModels() {
  try {
    const [models, catalog] = await Promise.all([api.listModels(), api.catalogStatus()]);
    useHubStore.getState().setModels(models);
    useHubStore.getState().setCatalog(catalog);
  } catch (e) {
    reportError(e);
  }
}

/** Fetch the signed catalog; offline or rejected catalogs only produce a warning. */
export async function checkForModelUpdates() {
  try {
    const { models, ...status } = await api.refreshCatalog();
    useHubStore.getState().setModels(models);
    useHubStore.getState().setCatalog(status);
    if (status.warning) useUiStore.getState().notify('warning', status.warning);
    else useUiStore.getState().notify('success', t.panel.catalogUpdated);
  } catch (e) {
    reportError(e);
  }
}

async function run(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (e) {
    reportError(e);
  }
}

export const installModel = (id: string) => run(() => api.installModel(id));
export const pauseModel = (id: string) => run(() => api.pauseModel(id));
export const resumeModel = (id: string) => run(() => api.resumeModel(id));
export const cancelModel = (id: string) => run(() => api.cancelModel(id));
export const openModelsFolder = () => run(() => api.openModelsFolder());

export const installModels = (ids: string[]) => run(() => api.installModels(ids));

async function queueMany(action: () => Promise<number>) {
  try {
    const n = await action();
    useUiStore.getState().notify('info', n === 0 ? t.panel.noneAvailable : t.panel.queuedMany(n));
  } catch (e) {
    reportError(e);
  }
}
export const installRecommended = () => queueMany(api.installRecommended);
export const installAll = () => queueMany(api.installAll);

/** Called for every `model:state` event. */
export function handleModelState(id: string, state: ModelState) {
  const hub = useHubStore.getState();
  const before = hub.models[id]?.state.kind;
  hub.setState(id, state);
  if (
    state.kind === 'installed' ||
    state.kind === 'notInstalled' ||
    state.kind === 'updateAvailable'
  ) {
    // Versions, sources and sizes changed on disk: take the backend's word for it.
    void refreshModels().then(() => {
      if (state.kind === 'installed' && before && (isActive(before) || before === 'paused')) {
        announceReady(id);
      }
    });
  }
}

/** One "ready" toast per finished install: for the feature once everything it needs is there. */
function announceReady(id: string) {
  const { models } = useHubStore.getState();
  const model = models[id];
  if (!model) return;
  const required = requiredFor(models, model.feature);
  const partOfFeature = required.some((m) => m.id === id);
  if (partOfFeature && !required.every(isUsable)) return;
  const label = partOfFeature ? featureLabel(model.feature) : model.name;
  const open = openers[model.feature] ?? (() => useUiStore.getState().openSettings('models'));
  useUiStore
    .getState()
    .notify('success', t.ready(label), undefined, [{ label: t.open, onClick: open }]);
}

/** Ask before deleting, then remove. Bundled models never get this far (no button). */
export async function removeInstalledModel(m: ModelInfo) {
  const choice = await ask({
    title: t.panel.removeTitle(m.name),
    message: t.panel.removeBody,
    cancelId: 'keep',
    buttons: [
      { id: 'remove', label: t.panel.removeConfirm, tone: 'danger' },
      { id: 'keep', label: t.panel.removeKeep },
    ],
  });
  if (choice !== 'remove') return;
  try {
    await api.removeModel(m.id);
    useUiStore.getState().notify('success', t.panel.removed(m.name));
  } catch (e) {
    reportError(e);
  }
}

/**
 * Install a model from a file the user already has. A file that does not match the published
 * checksum is only accepted after an explicit "I understand this file is unverified".
 */
export async function importModelFromFile(m: ModelInfo) {
  const path = await pickModelFile();
  if (!path) return;
  const notify = useUiStore.getState().notify;
  try {
    try {
      await api.importModelFile(m.id, path, false);
      notify('success', t.panel.imported(m.name));
    } catch (e) {
      if (toAppError(e).code !== 'Unverified') throw e;
      const choice = await ask({
        title: t.panel.unverifiedTitle,
        message: t.panel.unverifiedBody(m.name),
        cancelId: 'cancel',
        buttons: [
          { id: 'import', label: t.panel.unverifiedConfirm, tone: 'danger' },
          { id: 'cancel', label: t.panel.unverifiedCancel },
        ],
      });
      if (choice !== 'import') return;
      await api.importModelFile(m.id, path, true);
      notify('warning', t.panel.importedUnverified(m.name));
    }
  } catch (e) {
    reportError(e);
  } finally {
    await refreshModels();
  }
}
