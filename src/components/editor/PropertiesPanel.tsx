import * as Checkbox from '@radix-ui/react-checkbox';
import * as RadioGroup from '@radix-ui/react-radio-group';
import {
  Check,
  Image as ImageIcon,
  Link2,
  Link2Off,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react';
import { pickBackgroundImage } from '@/api/dialogs';
import { prepareBackgroundImage } from '@/api/image';
import { BRUSH_LIMITS } from '@/canvas/brush';
import { REFINE_LIMITS } from '@/canvas/maskOps';
import { strings } from '@/i18n/strings';
import {
  useActiveState,
  useEditorStore,
  type BackgroundKind,
  type FitMode,
} from '@/stores/editorStore';
import { assetUrl } from '@/utils/assetUrl';
import { NumberField } from './NumberField';
import { SliderRow } from './SliderRow';
import { reportError } from '@/app/errors';

const p = strings.editor.props;
const HEX = /^#[0-9a-fA-F]{6}$/;

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="border-t border-border px-5 py-2.5 first:border-t-0">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

export function PropertiesPanel() {
  const id = useEditorStore((s) => s.activeId);
  const state = useActiveState();
  const brush = useEditorStore((s) => s.brush);
  const recent = useEditorStore((s) => s.recentColors);
  const ed = useEditorStore.getState;
  const disabled = !id || !state;

  const chooseImage = async () => {
    if (!id) return;
    try {
      const path = await pickBackgroundImage();
      if (!path) return;
      const image = await prepareBackgroundImage(path);
      ed().setBackground(id, { kind: 'image', image });
    } catch (e) {
      reportError(e);
    }
  };

  const setKind = (kind: BackgroundKind) => {
    if (!id) return;
    if (kind === 'image' && !state?.background.image) void chooseImage();
    else ed().setBackground(id, { kind });
  };

  const setColor = (hex: string) => {
    if (!id) return;
    ed().setBackground(id, { kind: 'solid', color: hex });
  };

  const bg = state?.background;
  const out = state?.output;

  const setSize = (dim: 'width' | 'height', raw: number) => {
    if (!id || !state || !out || !Number.isFinite(raw) || raw < 1) return;
    const v = Math.round(raw);
    const ratio = state.source.width / state.source.height;
    if (!out.lockRatio) return ed().setOutput(id, { [dim]: v });
    ed().setOutput(
      id,
      dim === 'width'
        ? { width: v, height: Math.max(1, Math.round(v / ratio)) }
        : { height: v, width: Math.max(1, Math.round(v * ratio)) },
    );
  };

  return (
    <aside
      aria-label={p.title}
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-border bg-surface"
    >
      <h2 className="border-b border-border px-5 py-2.5 text-lg font-semibold">{p.title}</h2>

      <Section title={p.background}>
        <RadioGroup.Root
          value={bg?.kind ?? 'transparent'}
          onValueChange={(v) => setKind(v as BackgroundKind)}
          disabled={disabled}
          aria-label={p.background}
          className="flex flex-col gap-2.5"
        >
          {(
            [
              ['transparent', p.transparent],
              ['solid', p.solid],
              ['image', p.image],
            ] as const
          ).map(([value, label]) => (
            <div key={value} className="flex items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <RadioGroup.Item
                  value={value}
                  className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-primary bg-surface"
                >
                  <RadioGroup.Indicator className="h-2.5 w-2.5 rounded-full bg-primary" />
                </RadioGroup.Item>
                {label}
              </label>
              {value === 'transparent' && (
                <span
                  className="checkerboard h-7 w-12 rounded-sm border border-border"
                  aria-hidden
                />
              )}
              {value === 'solid' && (
                <label
                  className="relative h-7 w-12 cursor-pointer overflow-hidden rounded-sm border border-border"
                  style={{ background: bg?.color ?? '#fff' }}
                >
                  <span className="sr-only">{p.pickColor}</span>
                  <input
                    type="color"
                    value={bg?.color ?? '#ffffff'}
                    disabled={disabled}
                    onChange={(e) => setColor(e.target.value)}
                    onBlur={(e) => id && ed().addRecentColor(e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              )}
              {value === 'image' && (
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    aria-label={p.chooseImage}
                    onClick={() => void chooseImage()}
                    disabled={disabled}
                    className="flex h-7 w-10 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted"
                  >
                    {bg?.image ? (
                      <img
                        src={assetUrl(bg.image.cachePath)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageIcon size={16} aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={p.chooseImage}
                    onClick={() => void chooseImage()}
                    disabled={disabled}
                    className="flex h-7 w-7 items-center justify-center rounded-sm border border-border bg-muted"
                  >
                    <MoreHorizontal size={14} aria-hidden />
                  </button>
                </div>
              )}
            </div>
          ))}
        </RadioGroup.Root>

        {bg?.kind === 'solid' && (
          <div className="flex flex-col gap-2">
            <input
              aria-label={p.hexLabel}
              defaultValue={bg.color}
              key={bg.color}
              maxLength={7}
              onBlur={(e) => {
                const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
                if (HEX.test(v)) {
                  setColor(v.toLowerCase());
                  ed().addRecentColor(v.toLowerCase());
                } else e.target.value = bg.color;
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-full rounded-sm border border-border bg-muted px-2 py-1 text-sm uppercase"
            />
            {recent.length > 0 && (
              <div role="group" aria-label={p.recentColors} className="flex gap-1.5">
                {recent.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => setColor(c)}
                    className="h-6 w-6 rounded-full border border-border"
                    style={{ background: c }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {bg?.kind === 'image' && bg.image && (
          <div
            role="radiogroup"
            aria-label={p.imageFit}
            className="flex gap-1 rounded-md bg-muted p-1"
          >
            {(
              [
                ['cover', p.cover],
                ['contain', p.contain],
                ['stretch', p.stretch],
              ] as [FitMode, string][]
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={bg.fit === m}
                onClick={() => id && ed().setBackground(id, { fit: m })}
                className={`flex-1 rounded-sm px-2 py-1 text-xs font-medium ${bg.fit === m ? 'bg-primary text-primary-contrast' : 'hover:bg-surface'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={p.refine}
        action={
          <button
            type="button"
            aria-label={p.resetRefine}
            title={p.resetRefine}
            disabled={disabled}
            onClick={() => id && ed().resetRefine(id)}
            className="rounded-sm p-1 text-fg-muted hover:bg-muted disabled:opacity-40"
          >
            <RotateCcw size={15} aria-hidden />
          </button>
        }
      >
        {(
          [
            ['threshold', p.threshold],
            ['feather', p.feather],
            ['edgeShift', p.edgeShift],
          ] as const
        ).map(([key, label]) => (
          <SliderRow
            key={key}
            label={label}
            value={state?.refine[key] ?? 0}
            min={REFINE_LIMITS[key].min}
            max={REFINE_LIMITS[key].max}
            disabled={disabled}
            onChange={(v) => id && ed().setRefine(id, { [key]: v })}
            onCommit={() => id && ed().commitRefine(id)}
          />
        ))}
      </Section>

      <Section title={p.brush}>
        <SliderRow
          label={p.size}
          value={brush.size}
          min={BRUSH_LIMITS.size.min}
          max={BRUSH_LIMITS.size.max}
          onChange={(v) => ed().setBrush({ size: v })}
        />
        <SliderRow
          label={p.hardness}
          value={brush.hardness}
          min={BRUSH_LIMITS.hardness.min}
          max={BRUSH_LIMITS.hardness.max}
          onChange={(v) => ed().setBrush({ hardness: v })}
        />
      </Section>

      <Section title={p.output}>
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <div className="flex items-center gap-2">
            <NumberField
              label={p.width}
              value={out?.width}
              disabled={disabled}
              onCommit={(v) => setSize('width', v)}
            />
            <span aria-hidden>×</span>
            <NumberField
              label={p.height}
              value={out?.height}
              disabled={disabled}
              onCommit={(v) => setSize('height', v)}
            />
          </div>
          <button
            type="button"
            aria-label={p.lockRatio}
            aria-pressed={out?.lockRatio ?? true}
            disabled={disabled}
            onClick={() => id && out && ed().setOutput(id, { lockRatio: !out.lockRatio })}
            className="rounded-sm p-1.5 text-fg hover:bg-muted"
          >
            {out?.lockRatio === false ? (
              <Link2Off size={17} aria-hidden />
            ) : (
              <Link2 size={17} aria-hidden />
            )}
          </button>
        </div>
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <Checkbox.Root
            checked={out?.cropToSubject ?? false}
            disabled={disabled}
            onCheckedChange={(v) => id && ed().setOutput(id, { cropToSubject: v === true })}
            className="flex h-5 w-5 items-center justify-center rounded-sm border-2 border-primary bg-surface data-[state=checked]:bg-primary"
          >
            <Checkbox.Indicator>
              <Check size={14} className="text-primary-contrast" aria-hidden />
            </Checkbox.Indicator>
          </Checkbox.Root>
          {p.cropToSubject}
        </label>
      </Section>
    </aside>
  );
}
