import {
  Clock,
  Home,
  Info,
  Layers,
  ZoomIn,
  Settings,
  SlidersHorizontal,
  SquareDashed,
  type LucideIcon,
} from 'lucide-react';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useUiStore, type Screen } from '@/stores/uiStore';

const items: { screen: Screen; label: string; icon: LucideIcon }[] = [
  { screen: 'home', label: strings.nav.home, icon: Home },
  { screen: 'removeBackground', label: strings.nav.removeBackground, icon: SquareDashed },
  { screen: 'batch', label: strings.nav.batch, icon: Layers },
  { screen: 'edit', label: strings.nav.edit, icon: SlidersHorizontal },
  { screen: 'history', label: strings.nav.history, icon: Clock },
];

const base =
  'flex w-full items-center gap-3 whitespace-nowrap rounded-md px-4 py-3 text-left text-[14px] transition-colors';

export function Sidebar() {
  const screen = useUiStore((s) => s.screen);
  const setScreen = useUiStore((s) => s.setScreen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const propsTab = useEditorStore((s) => s.propsTab);
  const setPropsTab = useEditorStore((s) => s.setPropsTab);

  return (
    <nav
      aria-label={strings.nav.label}
      className="flex w-[230px] shrink-0 flex-col border-r border-border bg-surface px-3.5 py-4"
    >
      <ul className="flex flex-col gap-1.5">
        {items.map(({ screen: target, label, icon: Icon }) => {
          const active = screen === target;
          return (
            <li key={target}>
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setScreen(target)}
                className={`${base} ${
                  active
                    ? 'bg-primary font-medium text-primary-contrast shadow-card'
                    : 'text-fg hover:bg-muted'
                }`}
              >
                <Icon size={20} />
                {label}
              </button>
            </li>
          );
        })}
        <li>
          {/* Opens the editor on the Upscale tab. */}
          <button
            type="button"
            aria-current={screen === 'edit' && propsTab === 'upscale' ? 'page' : undefined}
            onClick={() => {
              setPropsTab('upscale');
              setScreen('edit');
            }}
            className={`${base} ${
              screen === 'edit' && propsTab === 'upscale'
                ? 'bg-primary font-medium text-primary-contrast shadow-card'
                : 'text-fg hover:bg-muted'
            }`}
          >
            <ZoomIn size={20} />
            {strings.nav.upscaler}
          </button>
        </li>
      </ul>

      <div className="mt-auto flex flex-col gap-1 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={`${base} hover:bg-muted`}
        >
          <Settings size={20} />
          {strings.nav.settings}
        </button>
        {/* TODO(phase-3): About lives in the Settings dialog. */}
        <button type="button" className={`${base} hover:bg-muted`}>
          <Info size={20} />
          {strings.nav.about}
        </button>
      </div>
    </nav>
  );
}
