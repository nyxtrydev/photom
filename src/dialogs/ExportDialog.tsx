import * as Checkbox from '@radix-ui/react-checkbox';
import * as Dialog from '@radix-ui/react-dialog';
import * as RadioGroup from '@radix-ui/react-radio-group';
import * as Slider from '@radix-ui/react-slider';
import { Check, Link2, Link2Off, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { pickExportFolder } from '@/api/dialogs';
import { deleteExportPreset, saveExportPreset } from '@/api/export';
import { getSettings } from '@/api/settings';
import { startExport } from '@/app/exportActions';
import {
  allPresets,
  initialExportOptions,
  matchingPreset,
  previewFilename,
} from '@/app/exportOptions';
import { NumberField } from '@/components/editor/NumberField';
import { strings } from '@/i18n/strings';
import { useRestoreFocus } from '@/hooks/useRestoreFocus';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { applyPreset, presetFrom, type ExportOptionsUi } from '@/types/export';
import { reportError } from '@/app/errors';
import { ignoreToastClicks } from '@/components/dialogOutside';

const t = strings.exportDialog;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-4 border-b border-border py-3 last:border-b-0">
      <div className="pt-1 text-sm font-medium">{label}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Radio({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm">
      <RadioGroup.Item
        value={value}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-surface"
      >
        <RadioGroup.Indicator className="h-2.5 w-2.5 rounded-full bg-primary" />
      </RadioGroup.Item>
      {children}
    </label>
  );
}

export function ExportDialog() {
  const request = useUiStore((s) => s.exportDialog);
  const set = useUiStore((s) => s.setExportDialog);
  useRestoreFocus(request !== null);
  return (
    <Dialog.Root open={request !== null} onOpenChange={(o) => !o && set(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          onInteractOutside={ignoreToastClicks}
          className="fixed left-1/2 top-1/2 z-40 max-h-[92vh] w-[min(40rem,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-7 shadow-card"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-3 font-display text-2xl font-medium">
              <Upload size={24} className="text-primary" aria-hidden />
              {t.title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={strings.settings.close}
              className="rounded-sm p-1 text-fg-muted hover:bg-muted"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t.filenameHint}</Dialog.Description>
          {request && <ExportForm request={request} onClose={() => set(null)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ExportForm({
  request,
  onClose,
}: {
  request: { scope?: 'current' | 'all'; presetId?: string };
  onClose: () => void;
}) {
  const [opts, setOpts] = useState<ExportOptionsUi>(() => initialExportOptions(request));
  const [folderError, setFolderError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Preset name being typed; `id` is set only when renaming an existing custom preset.
  const [naming, setNaming] = useState<{ text: string; id?: string } | null>(null);
  const custom = useSettingsStore((s) => s.exportPresets);
  const apply = useSettingsStore((s) => s.apply);
  const images = useProjectStore((s) => s.images);
  const masks = useProjectStore((s) => s.masks);
  const activeId = useEditorStore((s) => s.activeId);

  const presets = useMemo(() => allPresets(custom), [custom]);
  const current = matchingPreset(opts, presets);
  const active = images.find((i) => i.id === activeId);
  const set = (patch: Partial<ExportOptionsUi>) => setOpts((o) => ({ ...o, ...patch }));
  const setSize = (patch: Partial<ExportOptionsUi['size']>) =>
    setOpts((o) => ({ ...o, size: { ...o.size, ...patch } }));

  const sourceRatio = active ? active.width / active.height : 1;
  const setDim = (dim: 'width' | 'height', v: number) =>
    setOpts((o) => {
      if (!o.size.lockRatio) return { ...o, size: { ...o.size, [dim]: v } };
      return {
        ...o,
        size:
          dim === 'width'
            ? { ...o.size, width: v, height: Math.max(1, Math.round(v / sourceRatio)) }
            : { ...o.size, height: v, width: Math.max(1, Math.round(v * sourceRatio)) },
      };
    });

  const scopeImages = opts.scope === 'all' ? images : active ? [active] : [];
  const missing = scopeImages.filter((i) => !masks[i.id]).length;

  const syncSettings = async () => apply(await getSettings());

  const choosePreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) setOpts((o) => applyPreset(o, p.options));
  };

  const savePreset = async (name: string, id?: string) => {
    try {
      await saveExportPreset({ id: id ?? '', name, options: presetFrom(opts) });
      await syncSettings();
      setNaming(null);
    } catch (e) {
      reportError(e);
    }
  };

  const removePreset = async (id: string) => {
    try {
      await deleteExportPreset(id);
      await syncSettings();
    } catch (e) {
      reportError(e);
    }
  };

  const browse = async () => {
    const dir = await pickExportFolder();
    if (dir) {
      set({ folder: dir });
      setFolderError(false);
    }
  };

  const submit = async () => {
    if (!opts.folder.trim()) {
      setFolderError(true);
      return;
    }
    setBusy(true);
    const ok = await startExport(opts);
    setBusy(false);
    if (ok) onClose();
  };

  const exampleName = previewFilename(
    opts.filenameTemplate,
    active ? active.name.replace(/\.[^.]+$/, '') : 'photo',
    1,
    scopeImages.length,
  );
  const isCustomPreset = current && !current.builtIn;

  return (
    <div className="mt-3">
      <Row label={t.scope}>
        <RadioGroup.Root
          value={opts.scope}
          onValueChange={(v) => set({ scope: v as 'current' | 'all' })}
          aria-label={t.scope}
          className="flex gap-6"
        >
          <Radio value="current">{t.current}</Radio>
          <Radio value="all">
            <span className={images.length < 2 ? 'opacity-50' : ''}>{t.all(images.length)}</span>
          </Radio>
        </RadioGroup.Root>
        {missing > 0 && <p className="text-xs text-danger">{t.missingMasks(missing)}</p>}
      </Row>

      <Row label={t.background}>
        <RadioGroup.Root
          value={opts.background}
          onValueChange={(v) => set({ background: v as ExportOptionsUi['background'] })}
          aria-label={t.background}
          className="flex gap-6"
        >
          <Radio value="transparent">{t.transparent}</Radio>
          <Radio value="keepSelected">{t.keepBackground}</Radio>
        </RadioGroup.Root>
      </Row>

      <Row label={t.size}>
        <RadioGroup.Root
          value={opts.size.mode}
          onValueChange={(v) => setSize({ mode: v as 'original' | 'custom' })}
          aria-label={t.size}
          className="flex flex-col gap-2"
        >
          <Radio value="original">{t.original}</Radio>
          <Radio value="custom">{t.custom}</Radio>
        </RadioGroup.Root>
        {opts.size.mode === 'custom' && (
          <div className="flex items-center gap-2">
            <div className="w-24">
              <NumberField
                label={t.width}
                value={opts.size.width}
                min={1}
                max={32768}
                onCommit={(v) => setDim('width', v)}
              />
            </div>
            <span aria-hidden>×</span>
            <div className="w-24">
              <NumberField
                label={t.height}
                value={opts.size.height}
                min={1}
                max={32768}
                onCommit={(v) => setDim('height', v)}
              />
            </div>
            <button
              type="button"
              aria-label={t.lockRatio}
              aria-pressed={opts.size.lockRatio}
              onClick={() => setSize({ lockRatio: !opts.size.lockRatio })}
              className="rounded-sm p-1.5 hover:bg-muted"
            >
              {opts.size.lockRatio ? (
                <Link2 size={17} aria-hidden />
              ) : (
                <Link2Off size={17} aria-hidden />
              )}
            </button>
          </div>
        )}
        {opts.size.mode === 'original' && (
          <div className="flex items-center gap-2 text-sm">
            <span>{t.maxSide}</span>
            <div className="w-24">
              <NumberField
                label={t.maxSide}
                value={opts.size.maxSide ?? undefined}
                min={1}
                max={32768}
                onCommit={(v) => setSize({ maxSide: v })}
              />
            </div>
            {opts.size.maxSide !== null && (
              <button
                type="button"
                onClick={() => setSize({ maxSide: null })}
                className="text-xs text-fg-muted underline"
              >
                {strings.settings.exportTab.clear}
              </button>
            )}
          </div>
        )}
      </Row>

      <Row label={t.crop}>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <Checkbox.Root
              checked={opts.crop.enabled}
              onCheckedChange={(v) => set({ crop: { ...opts.crop, enabled: v === true } })}
              aria-label={t.crop}
              className="flex h-5 w-5 items-center justify-center rounded-sm border-2 border-primary bg-surface data-[state=checked]:bg-primary"
            >
              <Checkbox.Indicator>
                <Check size={14} className="text-primary-contrast" aria-hidden />
              </Checkbox.Indicator>
            </Checkbox.Root>
            {t.crop}
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span>{t.padding}</span>
            <div className="w-20">
              <NumberField
                label={t.padding}
                value={opts.crop.padding}
                min={0}
                max={5000}
                disabled={!opts.crop.enabled}
                onCommit={(v) => set({ crop: { ...opts.crop, padding: v } })}
              />
            </div>
            <span className="text-fg-muted">{t.px}</span>
          </div>
        </div>
      </Row>

      <Row label={t.compression}>
        <div className="flex items-center gap-3">
          <span className="w-14 text-xs text-fg-muted">{t.fast}</span>
          <Slider.Root
            className="relative flex h-5 flex-1 items-center"
            min={0}
            max={9}
            step={1}
            value={[opts.compression]}
            onValueChange={([v]) => v !== undefined && set({ compression: v })}
            aria-label={t.compression}
          >
            <Slider.Track className="relative h-1 grow rounded-full bg-border">
              <Slider.Range className="absolute h-full rounded-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb
              aria-label={t.compression}
              className="block h-4 w-4 rounded-full border-2 border-surface bg-primary shadow-card"
            />
          </Slider.Root>
          <span className="w-24 text-right text-xs text-fg-muted">{t.small}</span>
          <span className="w-4 text-sm tabular-nums" aria-hidden>
            {opts.compression}
          </span>
        </div>
      </Row>

      <Row label={t.filename}>
        <input
          aria-label={t.filename}
          value={opts.filenameTemplate}
          onChange={(e) => set({ filenameTemplate: e.target.value })}
          className="w-full rounded-sm border border-border bg-muted px-3 py-2 text-sm"
        />
        <p className="text-xs text-fg-muted">{t.filenamePreview(exampleName)}</p>
        <p className="text-xs text-fg-muted">{t.filenameHint}</p>
      </Row>

      <Row label={t.folder}>
        <div className="flex items-center gap-2">
          <input
            aria-label={t.folder}
            value={opts.folder}
            onChange={(e) => {
              set({ folder: e.target.value });
              setFolderError(false);
            }}
            placeholder="/path/to/folder"
            className="min-w-0 flex-1 rounded-sm border border-border bg-muted px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void browse()}
            className="rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border"
          >
            {t.browse}
          </button>
        </div>
        {folderError && (
          <p role="alert" className="text-xs text-danger">
            {t.noFolder}
          </p>
        )}
      </Row>

      <Row label={t.preset}>
        {naming === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t.preset}
              value={current?.id ?? '__custom'}
              onChange={(e) => e.target.value !== '__custom' && choosePreset(e.target.value)}
              className="rounded-sm border border-border bg-muted px-3 py-2 text-sm"
            >
              {!current && <option value="__custom">{t.customPreset}</option>}
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setNaming({ text: '' })}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              {t.saveAsPreset}
            </button>
            {isCustomPreset && current && (
              <>
                <button
                  type="button"
                  onClick={() => setNaming({ text: current.name, id: current.id })}
                  className="rounded-md px-3 py-2 text-sm hover:bg-muted"
                >
                  {t.rename}
                </button>
                <button
                  type="button"
                  onClick={() => void removePreset(current.id)}
                  className="rounded-md px-3 py-2 text-sm text-danger hover:bg-muted"
                >
                  {t.delete}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              aria-label={t.presetName}
              value={naming.text}
              onChange={(e) => setNaming({ ...naming, text: e.target.value })}
              onKeyDown={(e) =>
                e.key === 'Enter' && naming.text.trim() && void savePreset(naming.text, naming.id)
              }
              className="min-w-0 flex-1 rounded-sm border border-border bg-muted px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={!naming.text.trim()}
              onClick={() => void savePreset(naming.text, naming.id)}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
            >
              {t.savePreset}
            </button>
            <button
              type="button"
              onClick={() => setNaming(null)}
              className="rounded-md px-3 py-2 text-sm hover:bg-muted"
            >
              {t.cancel}
            </button>
          </div>
        )}
      </Row>

      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border bg-muted px-5 py-2.5 text-sm font-medium hover:bg-border"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded-md bg-primary px-6 py-2.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-60"
        >
          {busy ? t.exporting : t.export}
        </button>
      </div>
    </div>
  );
}
