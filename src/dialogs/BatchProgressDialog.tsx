import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Check, Clock, Loader2, X } from 'lucide-react';
import { jobControl, retryFailed } from '@/app/exportActions';
import { useRestoreFocus } from '@/hooks/useRestoreFocus';
import { strings } from '@/i18n/strings';
import { useProjectStore } from '@/stores/projectStore';
import { isFinished, useQueueStore } from '@/stores/queueStore';
import type { ItemStatus } from '@/types/export';
import { assetUrl } from '@/utils/assetUrl';
import { ignoreToastClicks } from '@/components/dialogOutside';

const b = strings.batch;

const chip: Record<ItemStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  done: {
    label: b.chip.done,
    cls: 'bg-success/15 text-success-fg',
    icon: <Check size={13} aria-hidden />,
  },
  processing: {
    label: b.chip.processing,
    cls: 'bg-primary/15 text-primary',
    icon: <Loader2 size={13} className="animate-spin" aria-hidden />,
  },
  queued: {
    label: b.chip.queued,
    cls: 'bg-muted text-fg-muted',
    icon: <Clock size={13} aria-hidden />,
  },
  failed: {
    label: b.chip.failed,
    cls: 'bg-danger/15 text-danger',
    icon: <AlertCircle size={13} aria-hidden />,
  },
  cancelled: {
    label: b.chip.cancelled,
    cls: 'bg-muted text-fg-muted',
    icon: <X size={13} aria-hidden />,
  },
};

/** Progress for batch removal / batch export, with Pause, Resume, Cancel and a summary at the end. */
export function BatchProgressDialog() {
  const jobId = useQueueStore((s) => s.dialogJobId);
  const snap = useQueueStore((s) => (s.dialogJobId ? s.jobs[s.dialogJobId] : undefined));
  const openDialog = useQueueStore((s) => s.openDialog);
  const images = useProjectStore((s) => s.images);

  const open = jobId !== null;
  useRestoreFocus(open);
  const finished = isFinished(snap);
  const total = snap?.total ?? 0;
  const done = snap?.done ?? 0;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const failed = snap?.items.filter((i) => i.status === 'failed').length ?? 0;
  const ok = snap?.items.filter((i) => i.status === 'done').length ?? 0;
  const title = snap?.kind === 'removeBackground' ? b.removeTitle : b.exportTitle;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && openDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          onInteractOutside={ignoreToastClicks}
          className="fixed left-1/2 top-1/2 z-40 flex max-h-[88vh] w-[min(38rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface p-7 shadow-card"
        >
          <Dialog.Title className="font-display text-2xl font-medium">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{b.progress(done, total)}</Dialog.Description>

          <div className="mt-4 flex items-center gap-4">
            <div
              role="progressbar"
              aria-label={title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-3 flex-1 overflow-hidden rounded-full bg-border"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-12 text-right text-sm font-medium tabular-nums">{pct}%</span>
          </div>
          <p className="mt-2 text-sm text-fg-muted" aria-live="polite">
            {snap?.status === 'paused'
              ? `${b.progress(done, total)} · ${b.paused}`
              : b.progress(done, total)}
          </p>

          <ul
            aria-label={title}
            className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1"
          >
            {snap?.items.map((it) => {
              const img = images.find((i) => i.id === it.id);
              const c = chip[it.status];
              return (
                <li
                  key={it.id}
                  className="flex items-center gap-3 rounded-md border border-border p-2.5"
                >
                  <span className="checkerboard h-10 w-10 shrink-0 overflow-hidden rounded-sm">
                    {img && (
                      <img
                        src={assetUrl(img.thumbnailPath)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={it.label}>
                      {it.label}
                    </p>
                    {it.error && (
                      <p className="truncate text-xs text-danger" title={it.error.message}>
                        {it.error.message}
                      </p>
                    )}
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${c.cls}`}
                  >
                    {c.icon}
                    {c.label}
                  </span>
                </li>
              );
            })}
          </ul>

          {finished && snap && (
            <p role="status" className="mt-4 text-sm font-medium">
              {snap.status === 'cancelled'
                ? b.summaryCancelled(ok, total)
                : b.summaryDone(ok, failed)}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-3">
            {!finished && snap && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void jobControl(snap.jobId, snap.status === 'paused' ? 'resume' : 'pause')
                  }
                  className="rounded-md border border-border bg-muted px-5 py-2.5 text-sm font-medium hover:bg-border"
                >
                  {snap.status === 'paused' ? b.resume : b.pause}
                </button>
                <button
                  type="button"
                  onClick={() => void jobControl(snap.jobId, 'cancel')}
                  className="rounded-md border border-danger px-5 py-2.5 text-sm font-medium text-danger hover:bg-danger hover:text-primary-contrast"
                >
                  {b.cancel}
                </button>
              </>
            )}
            {finished && failed > 0 && snap && (
              <button
                type="button"
                onClick={() => void retryFailed(snap.jobId)}
                className="rounded-md border border-border bg-muted px-5 py-2.5 text-sm font-medium hover:bg-border"
              >
                {b.retry}
              </button>
            )}
            <button
              type="button"
              onClick={() => openDialog(null)}
              className="rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover"
            >
              {finished ? b.close : b.hide}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
