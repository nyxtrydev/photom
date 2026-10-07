import { AlertTriangle, Download, Loader2, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useKeepFocus } from '@/hooks/useKeepFocus';
import { featureLabel } from '@/app/modelActions';
import {
  useModelRequirement,
  type ModelRequirement,
  type Requirement,
} from '@/hooks/useModelRequirement';
import { strings } from '@/i18n/strings';
import { useUiStore } from '@/stores/uiStore';
import { formatBytes, formatEta, formatSpeed } from '@/utils/format';

const t = strings.models.banner;

const btn =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50';
const primary =
  'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50';

interface Props {
  /** What the feature needs. */
  requirement: Requirement;
  /** Feature name shown in the banner. Defaults to the catalog feature label. */
  label?: string;
  className?: string;
}

/** Message for a failed install: our own wording per error code, never a raw OS string. */
function failureText(code: string, message: string) {
  const known = strings.models.errors[code];
  if (!known) return strings.models.errors.other;
  // Disk-full carries the numbers ("needs about 140 MB free, 80 MB available").
  return code === 'DiskFull'
    ? `${known} ${message.replace(/^Not enough disk space: /, '')}.`
    : known;
}

/** Announces download progress to screen readers every 10% instead of on every update. */
function useAnnounce(label: string, percent: number | null, active: boolean) {
  const [text, setText] = useState('');
  const last = useRef(-1);
  useEffect(() => {
    if (!active || percent === null) {
      last.current = -1;
      return;
    }
    const step = Math.floor(percent / 10) * 10;
    if (step !== last.current) {
      last.current = step;
      setText(t.announce(label, step));
    }
  }, [label, percent, active]);
  return text;
}

function Shell({
  icon,
  children,
  actions,
  tone = 'default',
}: {
  icon: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-md border bg-muted p-3 ${tone === 'danger' ? 'border-danger' : 'border-border'}`}
      data-testid="model-install-banner"
    >
      <span
        className={`shrink-0 ${tone === 'danger' ? 'text-danger' : 'text-primary'}`}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 basis-56 text-sm">{children}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

function Progress({ req, label }: { req: ModelRequirement; label: string }) {
  const p = req.progress;
  const pct = p?.percent ?? null;
  return (
    <div
      role="progressbar"
      aria-label={`${t.progressLabel}: ${label}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className="mt-2 h-2 overflow-hidden rounded-full bg-border"
    >
      <div
        className={`h-full bg-primary transition-[width] ${pct === null ? 'w-1/4 animate-pulse' : ''}`}
        style={pct === null ? undefined : { width: `${Math.max(pct, 2)}%` }}
      />
    </div>
  );
}

/**
 * Shown inside a feature panel while the models it needs are missing; disappears once they are
 * installed. All states (idle, downloading, paused, verifying, failed, not published) live here.
 */
export function ModelInstallBanner({ requirement, label, className }: Props) {
  const req = useModelRequirement(requirement);
  const openSettings = useUiStore((s) => s.openSettings);
  const name = label ?? ('feature' in requirement ? featureLabel(requirement.feature) : '');
  const announcement = useAnnounce(name, req.progress?.percent ?? null, req.phase === 'working');
  const box = useRef<HTMLDivElement>(null);
  useKeepFocus(box, `${req.phase}:${req.workingKind}`);

  // The live region stays mounted so announcements are heard even as the banner changes.
  const live = (
    <span role="status" aria-live="polite" className="sr-only">
      {announcement}
    </span>
  );
  if (req.ready) return live;

  const details = (
    <button type="button" className={btn} onClick={() => openSettings('models')}>
      {t.details}
    </button>
  );
  const p = req.progress;
  let body: ReactNode;

  switch (req.phase) {
    case 'working': {
      const stage = req.workingKind;
      const text =
        stage === 'verifying'
          ? t.verifying
          : stage === 'installing'
            ? t.installing
            : stage === 'queued'
              ? t.waiting(name)
              : p
                ? t.progress(
                    formatBytes(p.downloadedBytes),
                    formatBytes(p.totalBytes),
                    p.speedBps > 0 ? formatSpeed(p.speedBps) : null,
                    p.etaSeconds !== null ? formatEta(p.etaSeconds) : null,
                  )
                : t.downloading(name);
      const indeterminate = stage === 'verifying' || stage === 'installing' || stage === 'queued';
      body = (
        <Shell
          icon={<Loader2 size={20} className="animate-spin" />}
          actions={
            <>
              {(stage === 'downloading' || stage === 'queued') && (
                <button type="button" className={btn} onClick={() => void req.pause()}>
                  <Pause size={14} aria-hidden /> {t.pause}
                </button>
              )}
              {(stage === 'downloading' || stage === 'queued') && (
                <button type="button" className={btn} onClick={() => void req.cancel()}>
                  <X size={14} aria-hidden /> {t.cancel}
                </button>
              )}
            </>
          }
        >
          <p className="font-medium">{t.downloading(name)}</p>
          <p className="text-fg-muted">{text}</p>
          {indeterminate ? (
            <div
              role="progressbar"
              aria-label={`${t.progressLabel}: ${name}`}
              className="mt-2 h-2 overflow-hidden rounded-full bg-border"
            >
              <div className="h-full w-1/3 animate-pulse bg-primary" />
            </div>
          ) : (
            <Progress req={req} label={name} />
          )}
        </Shell>
      );
      break;
    }
    case 'paused':
      body = (
        <Shell
          icon={<Pause size={20} />}
          actions={
            <>
              <button type="button" className={primary} onClick={() => void req.resume()}>
                <Play size={14} aria-hidden /> {t.resume}
              </button>
              <button type="button" className={btn} onClick={() => void req.cancel()}>
                <X size={14} aria-hidden /> {t.cancel}
              </button>
            </>
          }
        >
          <p className="font-medium">{t.downloading(name)}</p>
          <p className="text-fg-muted">{t.pausedAt(formatBytes(p?.downloadedBytes ?? 0))}</p>
          <Progress req={req} label={name} />
        </Shell>
      );
      break;
    case 'failed':
      body = (
        <Shell
          tone="danger"
          icon={<AlertTriangle size={20} />}
          actions={
            <>
              <button type="button" className={primary} onClick={() => void req.install()}>
                {t.retry}
              </button>
              {req.failure?.code === 'Network' && (
                <button type="button" className={btn} onClick={() => openSettings('models')}>
                  {t.importFile}
                </button>
              )}
              {details}
            </>
          }
        >
          <p className="font-medium">{t.failedTitle(name)}</p>
          <p className="text-fg-muted">
            {failureText(req.failure?.code ?? '', req.failure?.message ?? '')}
          </p>
        </Shell>
      );
      break;
    case 'unavailable':
      body = (
        <Shell icon={<Download size={20} />} actions={details}>
          <p className="font-medium">
            {t.needs(name, req.missing.length, formatBytes(req.missingBytes))}
          </p>
          <p className="text-fg-muted">{t.notAvailable}</p>
        </Shell>
      );
      break;
    default:
      body = (
        <Shell
          icon={<Download size={20} />}
          actions={
            <>
              <button type="button" className={primary} onClick={() => void req.install()}>
                {t.install}
              </button>
              {details}
            </>
          }
        >
          <p className="font-medium">
            {t.needs(name, req.missing.length, formatBytes(req.missingBytes))}
          </p>
          <p className="text-fg-muted">{t.offlineAfter}</p>
        </Shell>
      );
  }

  return (
    <div className={className} ref={box}>
      {live}
      {body}
    </div>
  );
}

/**
 * Keeps a feature's controls visible but disabled (with an explanatory tooltip) until its models
 * are installed. Wrap the controls; the browser disables every form control inside a fieldset.
 */
export function ModelGate({
  requirement,
  label,
  children,
}: {
  requirement: Requirement;
  label?: string;
  children: ReactNode;
}) {
  const req = useModelRequirement(requirement);
  const name = label ?? ('feature' in requirement ? featureLabel(requirement.feature) : '');
  return (
    <fieldset
      disabled={!req.ready}
      title={req.ready ? undefined : t.locked(name)}
      className={`min-w-0 border-0 p-0 ${req.ready ? '' : 'opacity-60'}`}
    >
      {children}
    </fieldset>
  );
}
