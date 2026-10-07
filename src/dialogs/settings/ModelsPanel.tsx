import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useKeepFocus } from '@/hooks/useKeepFocus';
import {
  cancelModel,
  checkForModelUpdates,
  featureLabel,
  importModelFromFile,
  installAll,
  installModel,
  installRecommended,
  openModelsFolder,
  pauseModel,
  removeInstalledModel,
  resumeModel,
} from '@/app/modelActions';
import { updateSettings } from '@/app/settingsActions';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { strings } from '@/i18n/strings';
import { isActive, isUsable, useHubStore } from '@/stores/hubStore';
import type { ModelInfo, ModelProgress } from '@/types/models';
import { formatBytes } from '@/utils/format';

const t = strings.models.panel;
const st = strings.models.status;

const btn =
  'rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium hover:bg-border disabled:opacity-50';
const primary =
  'rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50';

function percent(p: ModelProgress | undefined): number | null {
  return p && p.totalBytes > 0
    ? Math.min(100, Math.floor((p.downloadedBytes / p.totalBytes) * 100))
    : null;
}

/** Text and colour of the status chip. */
function chip(m: ModelInfo, p: ModelProgress | undefined): { text: string; tone: string } {
  const quiet = 'border-border text-fg-muted';
  const good = 'border-success text-success-fg';
  const busy = 'border-primary text-fg';
  switch (m.state.kind) {
    case 'installed':
      return { text: m.source === 'bundled' ? st.included : st.installed, tone: good };
    case 'updateAvailable':
      return { text: st.updateAvailable, tone: busy };
    case 'downloading':
      return { text: st.downloading(percent(p)), tone: busy };
    case 'queued':
      return { text: st.queued, tone: busy };
    case 'paused':
      return { text: st.paused, tone: busy };
    case 'verifying':
      return { text: st.verifying, tone: busy };
    case 'installing':
      return { text: st.installing, tone: busy };
    case 'removing':
      return { text: st.removing, tone: quiet };
    case 'failed':
      return { text: st.failed, tone: 'border-danger text-danger' };
    default:
      return { text: m.installable ? st.notInstalled : st.unavailable, tone: quiet };
  }
}

function ModelRow({ m }: { m: ModelInfo }) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const progress = useHubStore((s) => s.progress[m.id]);
  const { text, tone } = chip(m, progress);
  const kind = m.state.kind;
  const pct = percent(progress);
  const detailsId = `model-details-${m.id}`;
  useKeepFocus(row, m.state.kind);

  return (
    <li ref={row} className="rounded-md border border-border p-3" data-testid={`model-${m.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium">{m.name}</p>
          <p className="text-xs text-fg-muted">
            {featureLabel(m.feature)} · v{m.version} · {formatBytes(m.sizeBytes)} · {m.license.name}
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
          data-testid={`status-${m.id}`}
        >
          {text}
        </span>
        {m.source === 'imported' && !m.verified && isUsable(m) && (
          <span
            className="rounded-full border border-primary px-2.5 py-0.5 text-xs font-medium"
            data-testid={`unverified-${m.id}`}
          >
            {t.unverified}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {(kind === 'notInstalled' || kind === 'failed') && (
            <button
              type="button"
              className={primary}
              disabled={!m.installable}
              title={m.installable ? undefined : strings.models.banner.notAvailable}
              onClick={() => void installModel(m.id)}
              aria-label={`${kind === 'failed' ? t.retry : t.install} ${m.name}`}
            >
              {kind === 'failed' ? t.retry : t.install}
            </button>
          )}
          {kind === 'updateAvailable' && (
            <button
              type="button"
              className={primary}
              onClick={() => void installModel(m.id)}
              aria-label={`${t.update} ${m.name}`}
            >
              {t.update}
            </button>
          )}
          {kind === 'downloading' && (
            <button
              type="button"
              className={btn}
              onClick={() => void pauseModel(m.id)}
              aria-label={`${t.pause} ${m.name}`}
            >
              {t.pause}
            </button>
          )}
          {kind === 'paused' && (
            <button
              type="button"
              className={primary}
              onClick={() => void resumeModel(m.id)}
              aria-label={`${t.resume} ${m.name}`}
            >
              {t.resume}
            </button>
          )}
          {(isActive(kind) || kind === 'paused') &&
            kind !== 'verifying' &&
            kind !== 'installing' && (
              <button
                type="button"
                className={btn}
                onClick={() => void cancelModel(m.id)}
                aria-label={`${t.cancel} ${m.name}`}
              >
                {t.cancel}
              </button>
            )}
          {(kind === 'notInstalled' ||
            kind === 'failed' ||
            kind === 'paused' ||
            kind === 'updateAvailable') && (
            <button
              type="button"
              className={btn}
              onClick={() => void importModelFromFile(m)}
              aria-label={`${t.importFile} ${m.name}`}
            >
              {t.importFile}
            </button>
          )}
          {m.removable &&
            (kind === 'installed' || kind === 'updateAvailable' || kind === 'failed') && (
              <button
                type="button"
                className={btn}
                onClick={() => void removeInstalledModel(m)}
                aria-label={`${t.remove} ${m.name}`}
              >
                {t.remove}
              </button>
            )}
          <button
            type="button"
            className={btn}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="inline-flex items-center gap-1">
              {open ? (
                <ChevronDown size={14} aria-hidden />
              ) : (
                <ChevronRight size={14} aria-hidden />
              )}
              {open ? t.hideDetails : t.details}
              <span className="sr-only"> {m.name}</span>
            </span>
          </button>
        </div>
      </div>

      {(kind === 'downloading' || kind === 'paused') && (
        <div
          role="progressbar"
          aria-label={`${strings.models.banner.progressLabel}: ${m.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"
        >
          <div className="h-full bg-primary" style={{ width: `${Math.max(pct ?? 0, 2)}%` }} />
        </div>
      )}
      {kind === 'failed' && m.state.kind === 'failed' && (
        <p className="mt-2 text-sm text-danger">
          {strings.models.errors[m.state.code] ?? strings.models.errors.other}
        </p>
      )}

      {open && (
        <dl id={detailsId} className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-muted">{t.details}</dt>
          <dd>{m.description}</dd>
          <dt className="text-fg-muted">{t.licence}</dt>
          <dd>
            {m.license.name}
            {m.license.commercialUse ? ` · ${t.commercialOk}` : ''}
            <span className="block break-all text-xs text-fg-muted">{m.license.url}</span>
          </dd>
          {m.license.attribution && (
            <>
              <dt className="text-fg-muted">{t.attribution}</dt>
              <dd>{m.license.attribution}</dd>
            </>
          )}
          <dt className="text-fg-muted">{t.checksum}</dt>
          <dd className="break-all font-mono text-xs">
            {/^0+$/.test(m.sha256) ? t.checksumPending : m.sha256}
          </dd>
          <dt className="text-fg-muted">{t.version}</dt>
          <dd>
            {m.version}
            {m.installedVersion ? ` (installed: ${m.installedVersion})` : ''}
          </dd>
          <dt className="text-fg-muted">{t.size}</dt>
          <dd>{t.requirements(m.requirements.minRamMb, m.requirements.gpuOptional)}</dd>
        </dl>
      )}
    </li>
  );
}

function AdvancedSettings() {
  const catalogUrl = useSettingsStore((s) => s.modelsCatalogUrl);
  const extraHost = useSettingsStore((s) => s.modelsExtraHost);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(catalogUrl ?? '');
  const [host, setHost] = useState(extraHost ?? '');
  const [urlError, setUrlError] = useState(false);
  const [hostError, setHostError] = useState(false);

  const save = async () => {
    const u = url.trim();
    const h = host.trim();
    const badUrl = u !== '' && !/^https:\/\/[^\s/]+/i.test(u);
    const badHost = h !== '' && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h);
    setUrlError(badUrl);
    setHostError(badHost);
    if (badUrl || badHost) return;
    await updateSettings({ modelsCatalogUrl: u || null, modelsExtraHost: h || null });
    // The backend keeps only values it accepts; show what it kept.
    const kept = useSettingsStore.getState();
    setUrl(kept.modelsCatalogUrl ?? '');
    setHost(kept.modelsExtraHost ?? '');
    const dropped = (u && !kept.modelsCatalogUrl) || (h && !kept.modelsExtraHost);
    useUiStore
      .getState()
      .notify(dropped ? 'warning' : 'success', dropped ? t.advancedRejected : t.advancedSaved);
  };
  const reset = async () => {
    setUrl('');
    setHost('');
    setUrlError(false);
    setHostError(false);
    await updateSettings({ modelsCatalogUrl: null, modelsExtraHost: null });
  };

  const input =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';
  return (
    <section className="mt-4 rounded-md border border-border p-3">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium"
        aria-expanded={open}
        aria-controls="models-advanced"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {t.advanced}
      </button>
      {open && (
        <div id="models-advanced" className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-fg-muted">{t.advancedHint}</p>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="models-catalog-url">{t.catalogUrl}</label>
            <input
              id="models-catalog-url"
              className={input}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
              spellCheck={false}
              aria-invalid={urlError}
              aria-describedby="catalog-url-hint"
            />
            <span
              id="catalog-url-hint"
              className={`text-xs ${urlError ? 'text-danger' : 'text-fg-muted'}`}
            >
              {urlError ? t.badUrl : t.catalogUrlHint}
            </span>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="models-extra-host">{t.extraHost}</label>
            <input
              id="models-extra-host"
              className={input}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              spellCheck={false}
              aria-invalid={hostError}
              aria-describedby="extra-host-hint"
            />
            <span
              id="extra-host-hint"
              className={`text-xs ${hostError ? 'text-danger' : 'text-fg-muted'}`}
            >
              {hostError ? t.badHost : t.extraHostHint}
            </span>
          </div>
          <div className="flex gap-2">
            <button type="button" className={primary} onClick={() => void save()}>
              {t.saveAdvanced}
            </button>
            <button type="button" className={btn} onClick={() => void reset()}>
              {t.resetAdvanced}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ModelsPanel() {
  const order = useHubStore((s) => s.order);
  const models = useHubStore((s) => s.models);
  const catalog = useHubStore((s) => s.catalog);
  const [checking, setChecking] = useState(false);

  const list = order.map((id) => models[id]).filter((m): m is ModelInfo => !!m);
  const diskBytes = list.filter(isUsable).reduce((n, m) => n + m.sizeBytes, 0);
  const anyOffline = list.some((m) => m.state.kind === 'failed' && m.state.code === 'Network');

  const check = async () => {
    setChecking(true);
    await checkForModelUpdates();
    setChecking(false);
  };

  return (
    <div>
      <h3 className="font-display text-xl font-medium">{t.title}</h3>
      <p className="mt-1 text-sm text-fg-muted">{t.intro}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={primary} onClick={() => void installRecommended()}>
          {t.installRecommended}
        </button>
        <button type="button" className={btn} onClick={() => void installAll()}>
          {t.installAll}
        </button>
        <button type="button" className={btn} disabled={checking} onClick={() => void check()}>
          {checking ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              {t.checking}
            </span>
          ) : (
            t.checkUpdates
          )}
        </button>
        <button type="button" className={btn} onClick={() => void openModelsFolder()}>
          {t.openFolder}
        </button>
      </div>

      {anyOffline && (
        <p className="mt-3 rounded-md border border-border bg-muted p-3 text-sm" role="status">
          {t.offlineNotice}
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-3" aria-label={t.list}>
        {list.map((m) => (
          <ModelRow key={m.id} m={m} />
        ))}
      </ul>

      <AdvancedSettings />

      <div className="mt-5 flex flex-col gap-1 border-t border-border pt-4 text-sm text-fg-muted">
        <p>{t.diskUsed(formatBytes(diskBytes))}</p>
        {catalog && (
          <p>
            {catalog.source === 'remote' ? t.catalogOnline : t.catalogBundled}
            {catalog.warning ? ` ${catalog.warning}` : ''}
          </p>
        )}
        <button
          type="button"
          className="w-fit text-left underline decoration-dotted underline-offset-4 hover:text-primary"
          onClick={() => {
            void updateSettings({ modelsOnboardingDone: false });
            // Feedback without a toast dependency: the setting is visible on the next start.
          }}
        >
          {t.showWelcome}
        </button>
      </div>
    </div>
  );
}
