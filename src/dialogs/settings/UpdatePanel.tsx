import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  checkForUpdate,
  installUpdate,
  onUpdateProgress,
  restartApp,
  type UpdateInfo,
} from '@/api/updates';
import { isTauri } from '@/api/window';
import { reportError } from '@/app/errors';
import { strings } from '@/i18n/strings';

const u = strings.settings.about.update;

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate'; version: string }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'installing'; info: UpdateInfo; pct: number | null }
  | { kind: 'ready'; info: UpdateInfo };

const btn =
  'rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border disabled:opacity-50';
const primary =
  'rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50';

/** Opt-in update check. Nothing is requested until the user clicks; updates are signature-verified. */
export function UpdatePanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onUpdateProgress((p) => {
      setPhase((cur) =>
        cur.kind === 'installing'
          ? { ...cur, pct: p.total ? Math.round((p.downloaded / p.total) * 100) : null }
          : cur,
      );
    }).then((un) => (cancelled ? un() : (unlisten = un)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const check = async () => {
    setPhase({ kind: 'checking' });
    try {
      const info = await checkForUpdate();
      setPhase(
        info.available
          ? { kind: 'available', info }
          : { kind: 'upToDate', version: info.currentVersion },
      );
    } catch (e) {
      reportError(e);
      setPhase({ kind: 'idle' });
    }
  };

  const install = async (info: UpdateInfo) => {
    setPhase({ kind: 'installing', info, pct: null });
    try {
      await installUpdate();
      setPhase({ kind: 'ready', info });
    } catch (e) {
      reportError(e);
      setPhase({ kind: 'available', info });
    }
  };

  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {(phase.kind === 'idle' || phase.kind === 'checking' || phase.kind === 'upToDate') && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={phase.kind === 'checking'}
            onClick={() => void check()}
            className={btn}
          >
            {phase.kind === 'checking' ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={15} className="animate-spin" aria-hidden />
                {u.checking}
              </span>
            ) : (
              u.check
            )}
          </button>
          {phase.kind === 'upToDate' && (
            <span className="text-sm text-success-fg">{u.upToDate(phase.version)}</span>
          )}
        </div>
      )}

      {phase.kind === 'available' && (
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">{u.available(phase.info.version ?? '')}</p>
          {phase.info.notes && (
            <p className="mt-1 whitespace-pre-line text-xs text-fg-muted">{phase.info.notes}</p>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" className={primary} onClick={() => void install(phase.info)}>
              {u.install}
            </button>
            <button type="button" className={btn} onClick={() => setPhase({ kind: 'idle' })}>
              {u.later}
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'installing' && (
        <div>
          <p className="text-sm">{u.installing(phase.info.version ?? '')}</p>
          <div
            role="progressbar"
            aria-label={u.installing(phase.info.version ?? '')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.pct ?? undefined}
            className="mt-2 h-2 w-64 overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${phase.pct ?? 5}%` }}
            />
          </div>
        </div>
      )}

      {phase.kind === 'ready' && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-success-fg">{u.ready(phase.info.version ?? '')}</span>
          <button
            type="button"
            className={primary}
            onClick={() => void restartApp().catch(reportError)}
          >
            {u.restart}
          </button>
        </div>
      )}
    </div>
  );
}
