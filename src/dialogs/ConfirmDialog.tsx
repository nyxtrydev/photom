import * as Dialog from '@radix-ui/react-dialog';
import { useRestoreFocus } from '@/hooks/useRestoreFocus';
import { useUiStore, type ConfirmButton } from '@/stores/uiStore';
import { ignoreToastClicks } from '@/components/dialogOutside';

const tone: Record<NonNullable<ConfirmButton['tone']>, string> = {
  primary: 'bg-primary text-primary-contrast hover:bg-primary-hover',
  danger: 'border border-danger text-danger hover:bg-danger hover:text-primary-contrast',
  default: 'border border-border bg-muted hover:bg-border',
};

/** Promise-based confirmation (see `ask()` in app/confirm.ts). */
export function ConfirmDialog() {
  const req = useUiStore((s) => s.confirm);
  const setConfirm = useUiStore((s) => s.setConfirm);
  useRestoreFocus(req !== null);
  const finish = (id: string) => {
    req?.resolve(id);
    setConfirm(null);
  };
  return (
    <Dialog.Root open={req !== null} onOpenChange={(open) => !open && req && finish(req.cancelId)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          onInteractOutside={ignoreToastClicks}
          className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-7 shadow-card"
        >
          <Dialog.Title className="font-display text-2xl font-medium">{req?.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-fg-muted">
            {req?.message}
          </Dialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            {req?.buttons.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => finish(b.id)}
                className={`rounded-md px-5 py-2.5 text-sm font-medium transition-colors ${tone[b.tone ?? 'default']}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
