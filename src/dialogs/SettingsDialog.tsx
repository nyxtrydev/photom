import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { X } from 'lucide-react';
import { useRestoreFocus } from '@/hooks/useRestoreFocus';
import { strings } from '@/i18n/strings';
import { useUiStore } from '@/stores/uiStore';
import { AboutPanel, ExportPanel, GeneralPanel, ModelPanel } from './settings/panels';
import { ShortcutsPanel } from './settings/ShortcutsPanel';
import { ignoreToastClicks } from '@/components/dialogOutside';

const tabs = [
  ['general', strings.settings.tabs.general, GeneralPanel],
  ['model', strings.settings.tabs.model, ModelPanel],
  ['export', strings.settings.tabs.export, ExportPanel],
  ['shortcuts', strings.settings.tabs.shortcuts, ShortcutsPanel],
  ['about', strings.settings.tabs.about, AboutPanel],
] as const;

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const tab = useUiStore((s) => s.settingsTab);
  const setTab = useUiStore((s) => s.setSettingsTab);
  useRestoreFocus(open);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          onInteractOutside={ignoreToastClicks}
          className="fixed left-1/2 top-1/2 z-40 flex h-[min(34rem,88vh)] w-[min(52rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card"
        >
          <div className="flex items-start justify-between px-7 pb-3 pt-6">
            <Dialog.Title className="font-display text-2xl font-medium">
              {strings.settings.title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={strings.settings.close}
              className="rounded-sm p-1 text-fg-muted hover:bg-muted"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            {strings.settings.general.themeHint}
          </Dialog.Description>
          <Tabs.Root
            value={tab}
            onValueChange={setTab}
            orientation="vertical"
            className="flex min-h-0 flex-1 border-t border-border"
          >
            <Tabs.List
              aria-label={strings.settings.title}
              className="flex w-44 shrink-0 flex-col gap-1 border-r border-border p-3"
            >
              {tabs.map(([id, label]) => (
                <Tabs.Trigger
                  key={id}
                  value={id}
                  className="rounded-md px-3 py-2 text-left text-sm data-[state=active]:bg-primary data-[state=active]:font-medium data-[state=active]:text-primary-contrast data-[state=inactive]:hover:bg-muted"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            {tabs.map(([id, , Panel]) => (
              <Tabs.Content key={id} value={id} className="min-w-0 flex-1 overflow-y-auto p-7">
                <Panel />
              </Tabs.Content>
            ))}
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
