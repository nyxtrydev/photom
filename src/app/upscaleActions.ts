import {
  upscaleAccept,
  upscaleBatch,
  upscaleCancel,
  upscaleDiscard,
  upscaleRun,
} from '@/api/upscale';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import { paramsFrom, useUpscaleStore } from '@/stores/upscaleStore';
import { useUiStore } from '@/stores/uiStore';
import type { JobSnapshot } from '@/types/export';
import type { KeptUpscale } from '@/types/dto';
import type { PendingUpscale, UpscaleParams } from '@/types/upscale';
import { reportError } from './errors';
import { jobControl, refreshJob } from './exportActions';

const t = strings.upscale;

/** Start an upscale of `id` with the options shown in the Upscale tab. */
export async function startUpscale(id: string): Promise<void> {
  const img = useProjectStore.getState().images.find((i) => i.id === id);
  if (!img) return;
  const ui = useUpscaleStore.getState();
  if (ui.runs[id]?.phase === 'running') return;
  const options = ui.optionsFor(id, img);
  // Mark it running first: the finished event can arrive before `upscaleRun` returns.
  ui.setRun(id, { phase: 'running', jobId: '' });
  try {
    const jobId = await upscaleRun(id, paramsFrom(options));
    ui.setRun(id, { phase: 'running', jobId });
    useQueueStore.getState().setRequest(jobId, { kind: 'upscale', items: [{ id, state: {} }] });
    void refreshJob(jobId);
  } catch (e) {
    ui.setRun(id, { phase: 'error', message: messageOf(e) });
  }
}

/** Upscale every open image with the same scale and options; each result is kept. */
export async function startUpscaleAll(sourceId: string): Promise<void> {
  const project = useProjectStore.getState();
  const img = project.images.find((i) => i.id === sourceId);
  if (!img || project.images.length < 2) return;
  const options = useUpscaleStore.getState().optionsFor(sourceId, img);
  if (options.scale === 'custom') {
    useUiStore.getState().notify('info', t.allNeedsScale);
    return;
  }
  await runBatch(
    project.images.map((i) => i.id),
    paramsFrom(options),
  );
}

async function runBatch(ids: string[], params: UpscaleParams): Promise<void> {
  try {
    const jobId = await upscaleBatch(ids, params);
    const q = useQueueStore.getState();
    q.setRequest(jobId, {
      kind: 'upscaleBatch',
      items: ids.map((id) => ({ id, state: {} as never })),
      upscaleParams: params,
    });
    q.openDialog(jobId);
    void refreshJob(jobId);
  } catch (e) {
    reportError(e);
  }
}

/** Run only the failed images of a finished batch again. */
export async function retryUpscaleBatch(jobId: string): Promise<void> {
  const q = useQueueStore.getState();
  const snap = q.jobs[jobId];
  const params = q.requests[jobId]?.upscaleParams;
  if (!snap || !params) return;
  const ids = snap.items.filter((i) => i.status === 'failed').map((i) => i.id);
  if (ids.length > 0) await runBatch(ids, params);
}

/** A batch image finished: its result is already kept by the backend. */
export function handleUpscaleBatchItem(result: unknown) {
  const r = result as { id?: unknown; kept?: KeptUpscale } | null;
  if (!r || typeof r.id !== 'string' || !r.kept) return;
  useEditorStore.getState().setUpscale(r.id, r.kept);
}

/** Stop a running batch: the queue ends after the current image, and the tile loop of that image. */
export function cancelUpscaleBatch(ids: string[]) {
  for (const id of ids) void upscaleCancel(id).catch(() => undefined);
}

const messageOf = (e: unknown) =>
  e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : t.failed;

/** The backend finished an upscale: show it for review. */
export function handleUpscaleComplete(result: unknown) {
  const r = result as Partial<PendingUpscale> | null;
  if (!r || typeof r.id !== 'string' || typeof r.path !== 'string') return;
  const ui = useUpscaleStore.getState();
  const run = ui.runs[r.id];
  if (!run) {
    // Cancelled while it was running: the result is not wanted, so drop the file too.
    void upscaleDiscard(r.id, false).catch(() => undefined);
    return;
  }
  // The same result is reported by the event and again by the final snapshot.
  if (run.phase === 'review' && run.pending.path === r.path) return;
  ui.setRun(r.id, { phase: 'review', pending: r as PendingUpscale });
}

/** A finished upscale job: report a failure or a cancellation (success was handled per item). */
export function handleUpscaleFinished(snap: JobSnapshot) {
  const ui = useUpscaleStore.getState();
  for (const item of snap.items) {
    const run = ui.runs[item.id];
    // A cancelled run was already cleared; the item then fails with 'Cancelled', not an error.
    if (item.status === 'failed' && run && item.error?.code !== 'Cancelled') {
      ui.setRun(item.id, { phase: 'error', message: item.error?.message ?? t.failed });
    } else if (item.status === 'done' && run?.phase === 'running' && item.result) {
      handleUpscaleComplete(item.result); // the event was missed: the snapshot has it
    }
  }
}

export async function cancelUpscale(id: string) {
  const run = useUpscaleStore.getState().runs[id];
  if (run?.phase !== 'running') return;
  // The running item finishes on its own (the queue never interrupts one); its result is dropped.
  useUpscaleStore.getState().clearRun(id);
  useUiStore.getState().notify('info', t.cancelled);
  void upscaleCancel(id).catch(() => undefined);
  if (run.jobId) await jobControl(run.jobId, 'cancel');
}

/** Keep the result under review: it becomes the image's upscaled version. */
export async function keepUpscale(id: string) {
  try {
    const kept = await upscaleAccept(id);
    useEditorStore.getState().setUpscale(id, kept);
    useUpscaleStore.getState().clearRun(id);
    useUiStore.getState().notify('success', t.kept(kept.width, kept.height));
  } catch (e) {
    reportError(e);
  }
}

/** Reject the result under review. An earlier kept version stays. */
export async function discardResult(id: string) {
  try {
    await upscaleDiscard(id, false);
    useUpscaleStore.getState().clearRun(id);
  } catch (e) {
    reportError(e);
  }
}

/** Remove the kept upscaled version: the image is back to its original. */
export async function revertUpscale(id: string) {
  try {
    await upscaleDiscard(id, true);
    useEditorStore.getState().setUpscale(id, null);
    useUpscaleStore.getState().clearRun(id);
  } catch (e) {
    reportError(e);
  }
}
