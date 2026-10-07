import { useMemo } from 'react';
import * as Checkbox from '@radix-ui/react-checkbox';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { AlertTriangle, Check, Link2, Link2Off, Loader2, RotateCcw } from 'lucide-react';
import {
  cancelUpscale,
  discardResult,
  keepUpscale,
  revertUpscale,
  startUpscale,
  startUpscaleAll,
} from '@/app/upscaleActions';
import { useModelRequirement } from '@/hooks/useModelRequirement';
import { ModelInstallBanner } from '@/components/ModelInstallBanner';
import { useUpscaleEstimate } from '@/hooks/useUpscaleEstimate';
import { strings } from '@/i18n/strings';
import { useActiveState, useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  defaultOptions,
  modelScaleFor,
  paramsFrom,
  useUpscaleStore,
  type ScaleChoice,
} from '@/stores/upscaleStore';
import { NumberField } from './NumberField';

const t = strings.upscale;

const primary =
  'inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50';
const secondary =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border disabled:opacity-50';

function Radio({
  value,
  children,
  disabled,
  hint,
}: {
  value: string;
  children: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className={`flex items-start gap-3 text-sm ${disabled ? '' : 'cursor-pointer'}`}>
      <RadioGroup.Item
        value={value}
        disabled={disabled}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-surface data-[disabled]:opacity-50"
      >
        <RadioGroup.Indicator className="h-2.5 w-2.5 rounded-full bg-primary" />
      </RadioGroup.Item>
      <span>
        <span className={disabled ? 'text-fg-muted' : undefined}>{children}</span>
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** The Upscale tab of the Properties panel. */
export function UpscalePanel() {
  const id = useEditorStore((s) => s.activeId);
  const state = useActiveState();
  const image = useProjectStore((s) => s.images.find((i) => i.id === id));
  const stored = useUpscaleStore((s) => (id ? s.options[id] : undefined));
  const srcW = state?.source.width ?? 0;
  const srcH = state?.source.height ?? 0;
  // Stable between renders: a fresh default object every time would re-render forever.
  const options = useMemo(
    () => stored ?? (state ? defaultOptions({ width: srcW, height: srcH }) : null),
    [stored, state, srcW, srcH],
  );
  const run = useUpscaleStore((s) => (id ? s.runs[id] : undefined));
  const imageCount = useProjectStore((s) => s.images.length);
  const setOptions = useUpscaleStore((s) => s.setOptions);
  const modelScale0 = options
    ? modelScaleFor(
        { width: srcW, height: srcH },
        options.scale === 'custom'
          ? options.target
          : { width: srcW * options.scale, height: srcH * options.scale },
      )
    : 2;
  const model = useModelRequirement({ models: [`upscale-x${modelScale0}`] });
  const params = options ? paramsFrom(options) : { engine: 'standard' as const };
  const estimate = useUpscaleEstimate(image ? image.id : null, params);

  if (!id || !state || !image || !options) {
    return (
      <p className="px-5 py-4 text-sm text-fg-muted" data-testid="upscale-panel">
        {t.needsImage}
      </p>
    );
  }

  const src = state.source;
  const set = (o: Partial<typeof options>) => setOptions(id, src, o);
  const ratio = src.width / src.height;
  const setDim = (dim: 'width' | 'height', v: number) =>
    set({
      target: options.lockRatio
        ? dim === 'width'
          ? { width: v, height: Math.max(1, Math.round(v / ratio)) }
          : { width: Math.max(1, Math.round(v * ratio)), height: v }
        : { ...options.target, [dim]: v },
    });

  const ready = estimate.status === 'ready' ? estimate.estimate : null;
  const blocking = ready?.warnings.find((w) => w.blocking);
  const large = ready?.warnings.some((w) => w.code === 'already-large') ?? false;
  const busy = run?.phase === 'running';
  const out = ready ? { width: ready.outW, height: ready.outH } : options.target;
  const modelScale = modelScaleFor(
    src,
    options.scale === 'custom'
      ? options.target
      : {
          width: src.width * options.scale,
          height: src.height * options.scale,
        },
  );
  const kept = state.upscale;

  return (
    <div className="flex flex-col gap-4 px-5 py-3" data-testid="upscale-panel">
      {options.engine === 'ai' && (
        <ModelInstallBanner
          requirement={{ models: [`upscale-x${modelScale}`] }}
          label={t.modelLabel}
        />
      )}

      <fieldset className="flex min-w-0 flex-col gap-2.5" disabled={busy}>
        <legend className="mb-1 text-base font-semibold">{t.scale}</legend>
        <RadioGroup.Root
          value={String(options.scale)}
          onValueChange={(v) =>
            set({ scale: v === 'custom' ? 'custom' : (Number(v) as ScaleChoice) })
          }
          aria-label={t.scale}
          className="flex flex-col gap-2.5"
        >
          <Radio value="2">{t.scale2}</Radio>
          <Radio value="4">{t.scale4}</Radio>
          <Radio value="custom">{t.custom}</Radio>
        </RadioGroup.Root>

        {options.scale === 'custom' && (
          <div className="flex items-center gap-2">
            <div className="w-24">
              <NumberField
                label={t.width}
                value={options.target.width}
                min={1}
                max={32768}
                onCommit={(v) => setDim('width', v)}
              />
            </div>
            <span aria-hidden>×</span>
            <div className="w-24">
              <NumberField
                label={t.height}
                value={options.target.height}
                min={1}
                max={32768}
                onCommit={(v) => setDim('height', v)}
              />
            </div>
            <button
              type="button"
              aria-label={t.lockRatio}
              aria-pressed={options.lockRatio}
              onClick={() => set({ lockRatio: !options.lockRatio })}
              className="rounded-sm p-1.5 hover:bg-muted"
            >
              {options.lockRatio ? (
                <Link2 size={17} aria-hidden />
              ) : (
                <Link2Off size={17} aria-hidden />
              )}
            </button>
          </div>
        )}
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-2.5" disabled={busy}>
        <legend className="mb-1 text-base font-semibold">{t.engine}</legend>
        <RadioGroup.Root
          value={options.engine}
          onValueChange={(v) => (v === 'standard' || v === 'ai') && set({ engine: v })}
          aria-label={t.engine}
          className="flex flex-col gap-2.5"
        >
          <Radio value="standard" hint={t.standardHint}>
            {t.standard}
          </Radio>
          <Radio value="ai" hint={t.aiHint}>
            {t.ai}
          </Radio>
        </RadioGroup.Root>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <Checkbox.Root
            checked={options.preDenoise}
            onCheckedChange={(v) => set({ preDenoise: v === true })}
            aria-label={t.reduceArtefacts}
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border-2 border-primary bg-surface data-[state=checked]:bg-primary"
          >
            <Checkbox.Indicator>
              <Check size={14} className="text-primary-contrast" aria-hidden />
            </Checkbox.Indicator>
          </Checkbox.Root>
          <span>
            {t.reduceArtefacts}
            <span className="block text-xs text-fg-muted">{t.reduceArtefactsHint}</span>
          </span>
        </label>
      </fieldset>

      <section aria-labelledby="upscale-estimate" className="flex flex-col gap-1.5">
        <h3 id="upscale-estimate" className="text-base font-semibold">
          {t.estimate}
        </h3>
        <div
          aria-live="polite"
          className="flex flex-col gap-1 text-sm"
          data-testid="upscale-estimate"
        >
          {estimate.status === 'loading' && <p className="text-fg-muted">{t.estimating}</p>}
          {estimate.status === 'invalid' && (
            <p className="flex gap-2 text-danger" role="alert">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              {estimate.message}
            </p>
          )}
          {ready && (
            <>
              <p>
                {t.sizeLine(
                  src.width,
                  src.height,
                  ready.outW,
                  ready.outH,
                  ready.megapixels.toFixed(1),
                )}
              </p>
              <p className="text-fg-muted">
                {t.timeLine(
                  ready.etaSeconds < 1 ? 'under a second' : `${Math.round(ready.etaSeconds)} s`,
                  ready.memoryMb >= 1000
                    ? `${(ready.memoryMb / 1000).toFixed(1)} GB`
                    : `${ready.memoryMb} MB`,
                )}
              </p>
              {ready.warnings.map((w) => (
                <p
                  key={w.code}
                  role={w.blocking ? 'alert' : 'status'}
                  className={`flex gap-2 rounded-md border p-2 ${w.blocking ? 'border-danger text-danger' : 'border-border bg-muted'}`}
                >
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                  {w.message}
                </p>
              ))}
            </>
          )}
        </div>
      </section>

      {run?.phase === 'error' && (
        <p
          role="alert"
          className="flex gap-2 rounded-md border border-danger p-2 text-sm text-danger"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <strong className="block">{t.errorTitle}</strong>
            {run.message}
          </span>
        </p>
      )}

      {busy ? (
        <div className="flex items-center gap-3" role="status">
          <Loader2 className="animate-spin text-primary" aria-hidden />
          <span className="flex-1 text-sm">{t.working}</span>
          <button type="button" className={secondary} onClick={() => void cancelUpscale(id)}>
            {t.cancel}
          </button>
        </div>
      ) : run?.phase === 'review' ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-muted">{t.reviewHint}</p>
          <div className="flex gap-2">
            <button type="button" className={primary} onClick={() => void keepUpscale(id)}>
              {t.keep}
            </button>
            <button type="button" className={secondary} onClick={() => void discardResult(id)}>
              {t.discard}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={primary}
          disabled={!ready || !!blocking || (options.engine === 'ai' && !model.ready)}
          onClick={() => void startUpscale(id)}
        >
          {run?.phase === 'error' ? t.retry : large ? t.upscaleAnyway : t.upscale}
        </button>
      )}

      {imageCount > 1 && run?.phase !== 'review' && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className={secondary}
            disabled={
              busy || options.scale === 'custom' || (options.engine === 'ai' && !model.ready)
            }
            onClick={() => void startUpscaleAll(id)}
          >
            {t.all(imageCount)}
          </button>
          <p className="text-xs text-fg-muted">
            {options.scale === 'custom' ? t.allNeedsScale : t.allHint}
          </p>
        </div>
      )}

      {kept && (
        <section
          aria-labelledby="upscale-kept"
          className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3"
        >
          <h3 id="upscale-kept" className="text-sm font-semibold">
            {t.keptTitle}
          </h3>
          <p className="text-sm">
            {t.keptLine(kept.width, kept.height, kept.scale ? t.howScale(kept.scale) : t.howCustom)}
          </p>
          <button type="button" className={secondary} onClick={() => void revertUpscale(id)}>
            <RotateCcw size={14} aria-hidden /> {t.revert}
          </button>
        </section>
      )}

      <p className="text-xs text-fg-muted">{t.honesty}</p>
      {out.width > 0 && <span className="sr-only">{t.resultSize(out.width, out.height)}</span>}
    </div>
  );
}
