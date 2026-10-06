import { Monitor, Moon, Sun } from 'lucide-react';
import { strings } from '@/i18n/strings';
import { changeTheme } from '@/app/settingsActions';
import { useUiStore, type ThemeMode } from '@/stores/uiStore';

const options: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: strings.theme.light, icon: Sun },
  { value: 'dark', label: strings.theme.dark, icon: Moon },
  { value: 'system', label: strings.theme.system, icon: Monitor },
];

export function ThemeSwitch() {
  const theme = useUiStore((s) => s.theme);

  return (
    <div
      role="radiogroup"
      aria-label={strings.theme.label}
      className="inline-flex rounded-md bg-muted p-1"
    >
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => changeTheme(value)}
          className={`inline-flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
            theme === value ? 'bg-primary text-primary-contrast' : 'text-fg hover:bg-surface'
          }`}
        >
          <Icon size={15} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
