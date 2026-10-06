import * as Menu from '@radix-ui/react-dropdown-menu';
import { LayoutGrid, List, MoreVertical, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { clearHistory, deleteHistoryItem, listHistory } from '@/api/export';
import { revealPath } from '@/api/settings';
import { importPaths } from '@/app/actions';
import { ask } from '@/app/confirm';
import { openProject } from '@/app/projectActions';
import { strings } from '@/i18n/strings';
import type { HistoryItem } from '@/types/export';
import { assetUrl } from '@/utils/assetUrl';
import { reportError } from '@/app/errors';

const t = strings.history;
const VIEW_KEY = 'photom.historyView';
type View = 'grid' | 'list';

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

const item =
  'flex cursor-default items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted';

export function History() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(loadView);

  const fail = (e: unknown) => {
    reportError(e);
  };

  useEffect(() => {
    let cancelled = false;
    listHistory()
      .then((l) => !cancelled && setItems(l))
      .catch((e) => {
        if (!cancelled) setItems([]);
        fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !items) return items ?? [];
    return items.filter((i) =>
      [i.name, i.outputPath, i.sourcePath].some((s) => s?.toLowerCase().includes(q)),
    );
  }, [items, query]);

  const openAgain = async (i: HistoryItem) => {
    if (i.kind === 'project' && i.outputPath) await openProject(i.outputPath);
    else if (i.sourcePath) await importPaths([i.sourcePath], { openEditor: true });
  };
  const reveal = async (i: HistoryItem) => {
    if (!i.outputPath) return;
    try {
      await revealPath(i.outputPath);
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (i: HistoryItem) => {
    try {
      setItems(await deleteHistoryItem(i.id));
    } catch (e) {
      fail(e);
    }
  };
  const clearAll = async () => {
    const choice = await ask({
      title: t.clearTitle,
      message: t.clearMessage,
      cancelId: 'cancel',
      buttons: [
        { id: 'clear', label: t.clearConfirm, tone: 'danger' },
        { id: 'cancel', label: strings.project.cancel },
      ],
    });
    if (choice !== 'clear') return;
    try {
      setItems(await clearHistory());
    } catch (e) {
      fail(e);
    }
  };

  const toggle = 'rounded-sm p-2 hover:bg-muted';
  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-medium">{t.title}</h1>
        <div className="flex items-center gap-2">
          <label className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
              aria-hidden
            />
            <input
              type="search"
              aria-label={t.search}
              placeholder={t.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-64 rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm"
            />
          </label>
          <div
            role="radiogroup"
            aria-label={t.view}
            className="inline-flex rounded-md bg-muted p-1"
          >
            <button
              type="button"
              role="radio"
              aria-checked={view === 'grid'}
              aria-label={t.grid}
              onClick={() => changeView('grid')}
              className={`${toggle} ${view === 'grid' ? 'bg-primary text-primary-contrast hover:bg-primary' : ''}`}
            >
              <LayoutGrid size={16} />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={view === 'list'}
              aria-label={t.list}
              onClick={() => changeView('list')}
              className={`${toggle} ${view === 'list' ? 'bg-primary text-primary-contrast hover:bg-primary' : ''}`}
            >
              <List size={16} />
            </button>
          </div>
          <button
            type="button"
            disabled={!items || items.length === 0}
            onClick={() => void clearAll()}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <Trash2 size={15} aria-hidden />
            {t.clearAll}
          </button>
        </div>
      </div>

      {items === null ? null : items.length === 0 ? (
        <p className="mt-8 rounded-md border border-dashed border-border px-6 py-12 text-center text-sm text-fg-muted">
          {t.empty}
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-8 text-center text-sm text-fg-muted">{t.noMatches}</p>
      ) : (
        <ul
          aria-label={t.title}
          className={
            view === 'grid'
              ? 'mt-6 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4'
              : 'mt-6 flex flex-col gap-2'
          }
        >
          {shown.map((i) => (
            <li
              key={i.id}
              className={`relative flex gap-3 rounded-md border border-border bg-surface p-3 shadow-card ${view === 'grid' ? '' : 'items-center'}`}
            >
              <button
                type="button"
                onClick={() => void openAgain(i)}
                aria-label={`${t.openAgain}: ${i.name}`}
                className="flex min-w-0 flex-1 gap-3 text-left"
              >
                <span
                  className={`checkerboard shrink-0 overflow-hidden rounded-sm ${view === 'grid' ? 'h-[84px] w-[84px]' : 'h-12 w-12'}`}
                >
                  {i.thumbnail && (
                    <img
                      src={assetUrl(i.thumbnail)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                </span>
                <span className="min-w-0 pr-6">
                  <span className="block truncate font-medium" title={i.outputPath ?? i.name}>
                    {i.name}
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {i.kind === 'export' ? t.export : t.project} · {when(i.timestamp)}
                  </span>
                  {view === 'list' && i.outputPath && (
                    <span className="block truncate text-xs text-fg-muted">{i.outputPath}</span>
                  )}
                </span>
              </button>
              <Menu.Root modal={false}>
                <Menu.Trigger
                  aria-label={t.actions(i.name)}
                  className="absolute right-2 top-2 rounded-sm p-1 text-fg-muted hover:bg-muted"
                >
                  <MoreVertical size={16} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content
                    align="end"
                    className="z-50 min-w-[190px] rounded-md border border-border bg-surface p-1 shadow-card"
                  >
                    <Menu.Item className={item} onSelect={() => void openAgain(i)}>
                      {t.openAgain}
                    </Menu.Item>
                    <Menu.Item
                      className={item}
                      disabled={!i.outputPath}
                      onSelect={() => void reveal(i)}
                    >
                      {t.reveal}
                    </Menu.Item>
                    <Menu.Item className={item} onSelect={() => void remove(i)}>
                      {t.delete}
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
