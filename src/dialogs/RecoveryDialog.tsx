import * as Dialog from '@radix-ui/react-dialog';
import { ask } from '@/app/confirm';
import { discardRecoveryEntry, restoreRecoveryEntry } from '@/app/projectActions';
import { strings } from '@/i18n/strings';
import { useUiStore } from '@/stores/uiStore';

const t = strings.project;

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Offered at startup when autosaves from a previous crash exist. */
export function RecoveryDialog() {
  const entries = useUiStore((s) => s.recovery);
  const setRecovery = useUiStore((s) => s.setRecovery);
  return (
    <Dialog.Root open={entries.length > 0} onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 w-[min(34rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-7 shadow-card"
        >
          <Dialog.Title className="font-display text-2xl font-medium">
            {t.recoveryTitle}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-fg-muted">
            {t.recoveryBody}
          </Dialog.Description>
          <ul className="mt-4 flex max-h-64 flex-col gap-2 overflow-y-auto">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{e.name}</p>
                  <p className="text-xs text-fg-muted">
                    {t.recoveryItem(e.imageCount, when(e.savedAt))}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => void restoreRecoveryEntry(e.id)}
                    className="rounded-sm bg-primary px-3 py-1.5 text-sm font-medium text-primary-contrast hover:bg-primary-hover"
                  >
                    {t.restore}
                  </button>
                  <button
                    type="button"
                    onClick={() => void discardRecoveryEntry(e.id)}
                    className="rounded-sm border border-border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    {t.discard}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {entries.length > 1 && (
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={async () => {
                  const all = [...entries];
                  const choice = await ask({
                    title: t.discardTitle,
                    message: t.discardMessage,
                    cancelId: 'cancel',
                    buttons: [
                      { id: 'discard', label: t.discardAll, tone: 'danger' },
                      { id: 'cancel', label: t.keep },
                    ],
                  });
                  if (choice !== 'discard') return;
                  setRecovery([]);
                  all.forEach((e) => void discardRecoveryEntry(e.id, false));
                }}
                className="text-sm text-danger hover:underline"
              >
                {t.discardAll}
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
