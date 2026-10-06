import * as Checkbox from '@radix-ui/react-checkbox';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { pickExportFolder, pickModelFile } from '@/api/dialogs';
import { getModelStatus } from '@/api/inference';
import { getAppInfo, importModel, openLogsFolder, readLicences } from '@/api/settings';
import { updateSettings } from '@/app/settingsActions';
import { NumberField } from '@/components/editor/NumberField';
import { UpdatePanel } from './UpdatePanel';
import { ThemeSwitch } from '@/components/ThemeSwitch';
import { strings } from '@/i18n/strings';
import { useModelStore } from '@/stores/modelStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { AppInfo, DevicePref, ModelKind } from '@/types/dto';
import { reportError } from '@/app/errors';

const g = strings.settings.general;
const m = strings.settings.model;
const e = strings.settings.exportTab;
const a = strings.settings.about;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border py-4 first:pt-0 last:border-b-0">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function Radio({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1 text-sm">
      <RadioGroup.Item
        value={value}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-surface"
      >
        <RadioGroup.Indicator className="h-2.5 w-2.5 rounded-full bg-primary" />
      </RadioGroup.Item>
      <span>
        {label}
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function GeneralPanel() {
  const s = useSettingsStore();
  return (
    <div>
      <Field label={g.theme} hint={g.themeHint}>
        <ThemeSwitch />
      </Field>
      <Field label={g.autosave} hint={g.autosaveHint}>
        <div className="flex w-40 items-center gap-2">
          <NumberField
            label={g.autosave}
            value={s.autosaveSeconds}
            min={10}
            max={3600}
            onCommit={(v) => void updateSettings({ autosaveSeconds: v })}
          />
          <span className="text-sm text-fg-muted">{g.seconds}</span>
        </div>
      </Field>
      <Field label={g.recentLimit}>
        <div className="w-24">
          <NumberField
            label={g.recentLimit}
            value={s.recentProjectsLimit}
            min={1}
            max={50}
            onCommit={(v) => void updateSettings({ recentProjectsLimit: v })}
          />
        </div>
      </Field>
      <Field label={g.undoDepth}>
        <div className="w-24">
          <NumberField
            label={g.undoDepth}
            value={s.undoDepth}
            min={1}
            max={500}
            onCommit={(v) => void updateSettings({ undoDepth: v })}
          />
        </div>
      </Field>
      <Field label={g.pixelLimit} hint={g.pixelLimitHint}>
        <div className="w-24">
          <NumberField
            label={g.pixelLimit}
            value={s.pixelLimitMp}
            min={1}
            max={1000}
            onCommit={(v) => void updateSettings({ pixelLimitMp: v })}
          />
        </div>
      </Field>
      <Field label={g.embed} hint={g.embedHint}>
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <Checkbox.Root
            checked={s.embedOriginals}
            onCheckedChange={(v) => void updateSettings({ embedOriginals: v === true })}
            aria-label={g.embed}
            className="flex h-5 w-5 items-center justify-center rounded-sm border-2 border-primary bg-surface data-[state=checked]:bg-primary"
          >
            <Checkbox.Indicator>
              <Check size={14} className="text-primary-contrast" aria-hidden />
            </Checkbox.Indicator>
          </Checkbox.Root>
        </label>
      </Field>
    </div>
  );
}

export function ModelPanel() {
  const modelType = useSettingsStore((s) => s.modelType);
  const processing = useSettingsStore((s) => s.processing);
  const status = useModelStore((s) => s.status);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const notify = useUiStore((s) => s.notify);

  const refresh = async () => {
    try {
      setInfo(await getAppInfo());
      useModelStore.getState().setStatus(await getModelStatus(modelType));
    } catch {
      /* shown elsewhere */
    }
  };
  useEffect(() => {
    void getAppInfo()
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void getModelStatus(modelType)
      .then((st) => useModelStore.getState().setStatus(st))
      .catch(() => undefined);
  }, [modelType]);

  const installed = info?.models.find((x) => x.kind === modelType);

  const doImport = async () => {
    const path = await pickModelFile();
    if (!path) return;
    try {
      await importModel(modelType, path);
      notify('success', m.imported);
      await refresh();
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div>
      <Field label={m.title}>
        <RadioGroup.Root
          value={modelType}
          onValueChange={(v) => void updateSettings({ modelType: v as ModelKind })}
          aria-label={m.title}
        >
          <Radio value="fast" label={m.fast} hint={m.fastHint} />
          <Radio value="quality" label={m.quality} hint={m.qualityHint} />
        </RadioGroup.Root>
      </Field>
      <Field label={m.processing} hint={m.gpuHint}>
        <RadioGroup.Root
          value={processing}
          onValueChange={(v) => void updateSettings({ processing: v as DevicePref })}
          aria-label={m.processing}
        >
          <Radio value="cpu" label={m.cpu} />
          <Radio value="gpuIfAvailable" label={m.gpu} />
        </RadioGroup.Root>
      </Field>
      <Field label={m.status} hint={installed?.path ?? undefined}>
        <p className="flex items-center gap-2 text-sm">
          <span
            className={`h-2.5 w-2.5 rounded-full ${installed?.present || status?.ready ? 'bg-success' : 'bg-danger'}`}
            aria-hidden
          />
          {installed?.present || status?.ready ? m.present : m.missing}
          {installed && <span className="text-fg-muted">({installed.fileName})</span>}
        </p>
        <div>
          <button
            type="button"
            onClick={() => void doImport()}
            className="rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border"
          >
            {m.import}
          </button>
          <p className="mt-1 text-xs text-fg-muted">{m.importHint}</p>
        </div>
      </Field>
    </div>
  );
}

const BUILT_IN_PRESETS = [
  ['web', e.presets.web],
  ['print', e.presets.print],
  ['original', e.presets.original],
] as const;

export function ExportPanel() {
  const folder = useSettingsStore((s) => s.defaultExportFolder);
  const preset = useSettingsStore((s) => s.defaultPreset);
  return (
    <div>
      <Field label={e.folder}>
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate rounded-sm border border-border bg-muted px-3 py-2 text-sm"
            title={folder ?? undefined}
          >
            {folder ?? e.folderNone}
          </span>
          <button
            type="button"
            onClick={async () => {
              const dir = await pickExportFolder();
              if (dir) void updateSettings({ defaultExportFolder: dir });
            }}
            className="rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border"
          >
            {e.browse}
          </button>
          <button
            type="button"
            disabled={!folder}
            onClick={() => void updateSettings({ defaultExportFolder: null })}
            className="rounded-md px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
          >
            {e.clear}
          </button>
        </div>
      </Field>
      <Field label={e.preset} hint={e.presetHint}>
        <select
          aria-label={e.preset}
          value={preset ?? 'web'}
          onChange={(ev) => void updateSettings({ defaultPreset: ev.target.value })}
          className="w-48 rounded-sm border border-border bg-muted px-3 py-2 text-sm"
        >
          {BUILT_IN_PRESETS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

export function AboutPanel() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void getAppInfo()
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  return (
    <div>
      <Field label={info ? a.version(info.version) : 'Photom'} hint={a.tagline}>
        <span />
      </Field>
      <Field label={a.licences} hint={a.thirdParty}>
        <ul className="text-sm">
          {info?.models.map((x) => (
            <li key={x.kind}>{a.modelLicence(x.fileName, x.licence)}</li>
          ))}
        </ul>
        <LicenceViewer />
      </Field>
      <Field label={a.logs}>
        <div>
          <button
            type="button"
            onClick={() => void openLogsFolder().catch(() => undefined)}
            className="rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border"
          >
            {a.logs}
          </button>
        </div>
      </Field>
      <Field label={a.updates} hint={a.updatesHint}>
        <UpdatePanel />
      </Field>
    </div>
  );
}

/** Shows the bundled third-party licence text on demand (it is ~2 MB, so it is not loaded until asked). */
function LicenceViewer() {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (text === null) {
      setLoading(true);
      try {
        setText(await readLicences());
      } catch (e) {
        reportError(e);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border"
      >
        {open ? a.hideLicences : a.viewLicences}
      </button>
      {open && (
        <pre
          tabIndex={0}
          aria-label={a.licences}
          className="mt-2 max-h-56 select-text overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-muted p-3 text-xs"
        >
          {loading ? a.licencesLoading : text}
        </pre>
      )}
    </div>
  );
}
