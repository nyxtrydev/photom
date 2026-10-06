import {
  cancelJob,
  copyToClipboard as copyToClipboardApi,
  exportPng,
  getJob,
  pauseJob,
  removeBackgroundBatch,
  resumeJob,
  type ExportItemRequest,
} from '@/api/export';
import { revealPath } from '@/api/settings';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { toPersisted } from '@/stores/persist';
import { isFinished, useQueueStore, type JobRequest } from '@/stores/queueStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { MaskResult } from '@/types/dto';
import {
  toApiOptions,
  type ExportOptionsUi,
  type ExportScope,
  type ExportedItem,
  type JobItemComplete,
  type JobSnapshot,
} from '@/types/export';
import { updateSettings } from './settingsActions';
import { reportError } from './errors';

const notify = useUiStore.getState;

function fail(e: unknown) {
  reportError(e);
}

/** Requests for the images in `scope`, each carrying that image's own editor state. */
export function buildItems(scope: ExportScope | string[]): ExportItemRequest[] {
  const { images } = useProjectStore.getState();
  const { states, activeId } = useEditorStore.getState();
  const ids = Array.isArray(scope)
    ? scope
    : scope === 'all'
      ? images.map((i) => i.id)
      : activeId
        ? [activeId]
        : [];
  return ids.map((id) => {
    const s = states[id];
    return { id, state: s ? toPersisted(s) : {} };
  });
}

const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    notify().notify('warning', strings.exportMsg.copyFailed);
  }
}

// ---- job snapshots --------------------------------------------------------------------------

const inflight = new Map<string, { again: boolean }>();

/** Pull the latest snapshot of a job. Events are only triggers; the snapshot is the truth. */
export async function refreshJob(jobId: string): Promise<JobSnapshot | null> {
  const running = inflight.get(jobId);
  if (running) {
    running.again = true;
    return null;
  }
  const state = { again: false };
  inflight.set(jobId, state);
  let snap: JobSnapshot | null = null;
  try {
    do {
      state.again = false;
      snap = await getJob(jobId);
      useQueueStore.getState().setSnapshot(snap);
    } while (state.again);
  } catch {
    /* job evicted or backend gone */
  } finally {
    inflight.delete(jobId);
  }
  if (snap && isFinished(snap)) reportFinished(snap);
  return snap;
}

function reportFinished(snap: JobSnapshot) {
  const q = useQueueStore.getState();
  if (q.reported[snap.jobId]) return;
  q.markReported(snap.jobId);
  const ok = snap.items.filter((i) => i.status === 'done');
  const failed = snap.items.filter((i) => i.status === 'failed').length;
  const m = strings.exportMsg;

  if (snap.status === 'cancelled') {
    notify().notify('info', m.cancelled(ok.length, snap.total));
    return;
  }
  if (snap.kind === 'removeBackground') {
    notify().notify(failed > 0 ? 'warning' : 'success', m.removed(ok.length, snap.total));
    return;
  }
  // Export: offer the folder and the path.
  const first = ok[0]?.result as ExportedItem | undefined;
  if (!first) {
    notify().notify('error', m.nothingExported);
    return;
  }
  const actions = [
    { label: m.openFolder, onClick: () => void revealPath(first.outputPath).catch(fail) },
    ...(ok.length === 1
      ? [{ label: m.copyPath, onClick: () => void copyText(first.outputPath) }]
      : []),
  ];
  const text =
    snap.total === 1
      ? m.exportedOne(first.outputPath.split(/[\\/]/).pop() ?? '')
      : m.exportedMany(ok.length, snap.total);
  notify().notify(
    failed > 0 ? 'warning' : 'success',
    text,
    failed > 0 ? m.someFailed(failed) : folderOf(first.outputPath),
    actions,
  );
}

/** A mask produced by a batch removal job: store it and make it undoable in the editor. */
function applyMaskResult(mask: MaskResult) {
  const project = useProjectStore.getState();
  const previous = project.masks[mask.id] ?? null;
  project.setMask(mask);
  const img = project.images.find((i) => i.id === mask.id);
  if (!img) return;
  const ed = useEditorStore.getState();
  ed.ensureState(mask.id, img.width, img.height);
  ed.recordRerun(mask.id, previous, mask);
}

export function handleItemComplete(e: JobItemComplete) {
  const r = e.result as Partial<MaskResult> | null;
  if (r && typeof r.maskPath === 'string' && typeof r.id === 'string')
    applyMaskResult(r as MaskResult);
  void refreshJob(e.jobId);
}

// ---- starting jobs --------------------------------------------------------------------------

/** Start an export. Several images open the progress dialog; one image just shows a toast when done. */
export async function startExport(options: ExportOptionsUi): Promise<boolean> {
  const items = buildItems(options.scope);
  if (items.length === 0) {
    notify().notify('info', strings.exportMsg.noImages);
    return false;
  }
  const api = toApiOptions(options);
  try {
    const jobId = await exportPng(items, api);
    useQueueStore.getState().setRequest(jobId, { kind: 'export', items, options: api });
    if (items.length > 1) useQueueStore.getState().openDialog(jobId);
    void refreshJob(jobId);
    const last = useSettingsStore.getState().lastUsedFolders;
    if (options.folder && last.export !== options.folder) {
      void updateSettings({ lastUsedFolders: { ...last, export: options.folder } });
    }
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** Remove backgrounds for `ids` (default: every image that has no cut-out yet). */
export async function startBatchRemoval(ids?: string[]): Promise<void> {
  const project = useProjectStore.getState();
  const target = ids ?? project.images.filter((i) => !project.masks[i.id]).map((i) => i.id);
  if (target.length === 0) {
    notify().notify('info', strings.exportMsg.allCutOut);
    return;
  }
  const { modelType, processing } = useSettingsStore.getState();
  try {
    const jobId = await removeBackgroundBatch(target, { model: modelType, device: processing });
    useQueueStore
      .getState()
      .setRequest(jobId, { kind: 'removeBackground', items: buildItems(target) });
    useQueueStore.getState().openDialog(jobId);
    void refreshJob(jobId);
  } catch (e) {
    fail(e);
  }
}

/** Run only the failed items of a finished job again. */
export async function retryFailed(jobId: string): Promise<void> {
  const q = useQueueStore.getState();
  const snap = q.jobs[jobId];
  const req: JobRequest | undefined = q.requests[jobId];
  if (!snap || !req) return;
  const failedIds = new Set(snap.items.filter((i) => i.status === 'failed').map((i) => i.id));
  const items = buildItems(req.items.filter((i) => failedIds.has(i.id)).map((i) => i.id));
  if (items.length === 0) return;
  try {
    const next =
      req.kind === 'export' && req.options
        ? await exportPng(items, req.options)
        : await removeBackgroundBatch(
            items.map((i) => i.id),
            {
              model: useSettingsStore.getState().modelType,
              device: useSettingsStore.getState().processing,
            },
          );
    useQueueStore.getState().setRequest(next, { ...req, items });
    useQueueStore.getState().openDialog(next);
    void refreshJob(next);
  } catch (e) {
    fail(e);
  }
}

export async function jobControl(jobId: string, action: 'pause' | 'resume' | 'cancel') {
  try {
    await (action === 'pause' ? pauseJob : action === 'resume' ? resumeJob : cancelJob)(jobId);
  } catch (e) {
    fail(e);
  }
  void refreshJob(jobId);
}

/** Render the current image with the export settings and put it on the clipboard (PNG with alpha). */
export async function copyCurrentToClipboard(options: ExportOptionsUi): Promise<void> {
  const [item] = buildItems('current');
  if (!item) {
    notify().notify('info', strings.exportMsg.noImages);
    return;
  }
  try {
    await copyToClipboardApi(item, toApiOptions({ ...options, folder: options.folder || '/' }));
    notify().notify('success', strings.exportMsg.copied);
  } catch (e) {
    fail(e);
  }
}
