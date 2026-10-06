import * as Menu from '@radix-ui/react-dropdown-menu';
import { FolderOpen, MoreVertical, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { clearRecentProjects, pathsExist, removeRecentProject, revealPath } from '@/api/settings';
import { ask } from '@/app/confirm';
import { openProject } from '@/app/projectActions';
import { strings } from '@/i18n/strings';
import { useSettingsStore } from '@/stores/settingsStore';
import type { RecentProject } from '@/types/dto';
import { assetUrl } from '@/utils/assetUrl';
import { reportError } from '@/app/errors';

const r = strings.recent;

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const item =
  'flex cursor-default items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted';

export function RecentProjects() {
  const recent = useSettingsStore((s) => s.recentProjects);
  const apply = useSettingsStore((s) => s.apply);
  const [available, setAvailable] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (recent.length === 0) return;
    let cancelled = false;
    pathsExist(recent.map((p) => p.path))
      .then((flags) => {
        if (cancelled) return;
        setAvailable(Object.fromEntries(recent.map((p, i) => [p.path, flags[i] ?? false])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recent]);

  const fail = (e: unknown) => {
    reportError(e);
  };

  const clear = async () => {
    const choice = await ask({
      title: r.clearTitle,
      message: r.clearMessage,
      cancelId: 'cancel',
      buttons: [
        { id: 'clear', label: r.clearConfirm, tone: 'danger' },
        { id: 'cancel', label: strings.project.cancel },
      ],
    });
    if (choice !== 'clear') return;
    try {
      apply(await clearRecentProjects());
    } catch (e) {
      fail(e);
    }
  };

  const reveal = async (p: RecentProject) => {
    try {
      await revealPath(p.path);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (p: RecentProject) => {
    try {
      apply(await removeRecentProject(p.path));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section aria-labelledby="recent-title" className="px-8 pb-6 pt-6">
      <div className="flex items-center justify-between">
        <h2 id="recent-title" className="text-xl font-semibold">
          {strings.home.recentTitle}
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void openProject()}
            className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            <FolderOpen size={16} aria-hidden />
            {r.openProject}
          </button>
          <button
            type="button"
            disabled={recent.length === 0}
            onClick={() => void clear()}
            className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <Trash2 size={16} aria-hidden />
            {strings.home.clear}
          </button>
        </div>
      </div>

      {recent.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border px-6 py-8 text-center text-sm text-fg-muted">
          {strings.home.recentEmpty}
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
          {recent.map((p) => {
            const ok = available[p.path] !== false;
            return (
              <li
                key={p.path}
                className={`relative flex gap-3 rounded-md border border-border bg-surface p-3 shadow-card ${ok ? '' : 'opacity-70'}`}
              >
                <button
                  type="button"
                  disabled={!ok}
                  onClick={() => void openProject(p.path)}
                  className="flex min-w-0 flex-1 gap-3 text-left disabled:cursor-not-allowed"
                  aria-label={`${r.open} ${p.name}`}
                >
                  <span className="checkerboard h-[84px] w-[84px] shrink-0 overflow-hidden rounded-sm">
                    {p.thumbnail && (
                      <img
                        src={assetUrl(p.thumbnail)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </span>
                  <span className="min-w-0 pr-6">
                    <span className="block truncate font-medium" title={p.path}>
                      {p.name}.photom
                    </span>
                    <span className="block text-sm text-fg-muted">
                      {ok ? (
                        formatWhen(p.modified)
                      ) : (
                        <span className="text-danger">{r.unavailable}</span>
                      )}
                    </span>
                  </span>
                </button>
                <Menu.Root modal={false}>
                  <Menu.Trigger
                    aria-label={r.menu(p.name)}
                    className="absolute right-2 top-2 rounded-sm p-1 text-fg-muted hover:bg-muted"
                  >
                    <MoreVertical size={16} />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content
                      align="end"
                      className="z-50 min-w-[190px] rounded-md border border-border bg-surface p-1 shadow-card"
                    >
                      <Menu.Item
                        className={item}
                        disabled={!ok}
                        onSelect={() => void openProject(p.path)}
                      >
                        {r.open}
                      </Menu.Item>
                      <Menu.Item className={item} disabled={!ok} onSelect={() => void reveal(p)}>
                        {r.reveal}
                      </Menu.Item>
                      <Menu.Item className={item} onSelect={() => void remove(p)}>
                        {r.remove}
                      </Menu.Item>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu.Root>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
