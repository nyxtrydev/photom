import * as Dialog from '@radix-ui/react-dialog';
import { installRecommended } from '@/app/modelActions';
import { updateSettings } from '@/app/settingsActions';
import { useRestoreFocus } from '@/hooks/useRestoreFocus';
import { strings } from '@/i18n/strings';
import { useHubStore } from '@/stores/hubStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { formatBytes } from '@/utils/format';

const t = strings.models.welcome;

/**
 * One-time offer to install the recommended models. Never forced, never shown again after an
 * answer, and only shown when there is something to download.
 */
export function ModelsWelcomeDialog() {
  const done = useSettingsStore((s) => s.modelsOnboardingDone);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const models = useHubStore((s) => s.models);
  const hubLoaded = useHubStore((s) => s.loaded);
  const blocked = useUiStore(
    (s) => s.settingsOpen || s.confirm !== null || s.recovery.length > 0 || s.exportDialog !== null,
  );
  const screen = useUiStore((s) => s.screen);
  const empty = useProjectStore((s) => s.images.length === 0);

  const wanted = Object.values(models).filter(
    (m) => m.recommended && m.installable && m.state.kind === 'notInstalled',
  );
  const open =
    settingsLoaded &&
    hubLoaded &&
    !done &&
    wanted.length > 0 &&
    !blocked &&
    screen === 'home' &&
    empty;
  useRestoreFocus(open);

  const answer = (install: boolean) => {
    void updateSettings({ modelsOnboardingDone: true });
    if (install) void installRecommended();
  };
  const size = formatBytes(wanted.reduce((n, m) => n + m.sizeBytes, 0));

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && answer(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-40 w-[min(32rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-7 shadow-card">
          <Dialog.Title className="font-display text-2xl font-medium">{t.title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-fg-muted">{t.body}</Dialog.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(false)}
              className="rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border"
            >
              {t.skip}
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-contrast hover:bg-primary-hover"
            >
              {t.install(size)}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
