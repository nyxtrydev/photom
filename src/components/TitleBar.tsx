import { Maximize2, Minimize2, Minus, Settings, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import logo from '@/assets/logo.png';
import { isTauri, windowApi } from '@/api/window';
import { strings } from '@/i18n/strings';
import { useUiStore } from '@/stores/uiStore';

const btn =
  'inline-flex h-10 w-12 items-center justify-center rounded-sm border border-border bg-surface text-fg transition-colors hover:bg-muted';

interface TitleBarProps {
  /** Optional content next to the wordmark, e.g. the editor menu bar. */
  children?: ReactNode;
  /** Optional centred title, e.g. the project name. */
  centre?: ReactNode;
}

export function TitleBar({ children, centre }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const openSettings = () => useUiStore.getState().setSettingsOpen(true);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    const sync = () => void windowApi.isMaximized().then(setMaximized);
    sync();
    void windowApi.onResized(sync).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const t = strings.titleBar;
  const run = (fn: () => Promise<unknown>) => () => {
    if (isTauri()) void fn();
  };

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-5"
    >
      <div data-tauri-drag-region className="flex items-center gap-3">
        <img src={logo} alt="" className="pointer-events-none h-9 w-9" draggable={false} />
        <span className="pointer-events-none font-display text-[28px] font-medium leading-none">
          {strings.app.name}
        </span>
        {children}
      </div>
      {centre && (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm">
          {centre}
        </div>
      )}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={openSettings}
          className="inline-flex items-center gap-2 text-sm font-medium text-fg hover:text-primary"
        >
          <Settings size={18} aria-hidden />
          {t.settings}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label={t.minimize}
            className={btn}
            onClick={run(windowApi.minimize)}
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            aria-label={maximized ? t.restore : t.maximize}
            className={btn}
            onClick={run(windowApi.toggleMaximize)}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            aria-label={t.close}
            className={`${btn} hover:bg-danger hover:text-primary-contrast`}
            onClick={run(windowApi.close)}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
