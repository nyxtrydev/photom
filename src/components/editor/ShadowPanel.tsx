import * as Checkbox from '@radix-ui/react-checkbox';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { removeBackground } from '@/app/actions';
import { applyShadowToAll } from '@/app/exportActions';
import {
  clampLayer,
  defaultShadow,
  newLayer,
  SHADOW_LIMITS,
  usesGround,
  type LayerType,
  type ShadowLayer,
  type ShadowState,
} from '@/canvas/shadow';
import { strings } from '@/i18n/strings';
import { useActiveState, useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { ColorField } from './ColorField';
import { ShadowPresets } from './ShadowPresets';
import { SliderRow } from './SliderRow';

const t = strings.shadow;
const L = SHADOW_LIMITS;

const menuContent = 'z-50 w-[260px] rounded-md border border-border bg-surface p-1 shadow-card';
const menuItem =
  'flex cursor-default flex-col gap-0.5 rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted';

const iconBtn =
  'flex h-8 w-8 items-center justify-center rounded-sm text-fg-muted hover:bg-muted disabled:opacity-40';

function Check2({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm">
      <Checkbox.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border-2 border-primary bg-surface data-[state=checked]:bg-primary"
      >
        <Checkbox.Indicator>
          <Check size={14} className="text-primary-contrast" aria-hidden />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span>
        {label}
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

type Num = {
  key: string;
  label: string;
  min: number;
  max: number;
  /** Stored value = shown value / scale. */
  scale?: number;
  step?: number;
};

/** The sliders each layer type shows, in order. */
const FIELDS: Record<ShadowLayer['type'], Num[]> = {
  drop: [
    { key: 'angle', label: t.angle, ...L.angle },
    { key: 'distance', label: t.distance, ...L.distance },
    { key: 'blur', label: t.blur, ...L.blur },
    { key: 'spread', label: t.spread, ...L.spread },
    { key: 'opacity', label: t.opacity, min: 0, max: 100, scale: 100 },
  ],
  contact: [
    { key: 'size', label: t.size, ...L.size },
    { key: 'softness', label: t.softness, ...L.softness },
    { key: 'opacity', label: t.opacity, min: 0, max: 100, scale: 100 },
    { key: 'groundOffset', label: t.groundOffset, ...L.groundOffset },
  ],
  reflection: [
    { key: 'gap', label: t.gap, ...L.gap },
    { key: 'fade', label: t.fadeLength, ...L.fade },
    { key: 'blur', label: t.blur, ...L.reflectionBlur },
    { key: 'opacity', label: t.opacity, min: 0, max: 100, scale: 100 },
  ],
  cast: [
    { key: 'angle', label: t.lightAngle, ...L.angle },
    { key: 'elevation', label: t.elevation, ...L.elevation },
    { key: 'length', label: t.length, min: 10, max: 200, scale: 100 },
    { key: 'squash', label: t.squash, min: 10, max: 100, scale: 100 },
    { key: 'falloff', label: t.falloff, min: 0, max: 100, scale: 100 },
    { key: 'blur', label: t.blur, ...L.castBlur },
    { key: 'blurGrowth', label: t.blurGrowth, ...L.blurGrowth },
    { key: 'opacity', label: t.opacity, min: 0, max: 100, scale: 100 },
  ],
};

function LayerCard({
  layer,
  imageId,
  disabled,
  index,
  count,
}: {
  layer: ShadowLayer;
  imageId: string;
  disabled: boolean;
  index: number;
  count: number;
}) {
  const ed = useEditorStore.getState;
  const patch = (p: Partial<ShadowLayer>, live: boolean) =>
    ed().setShadow(
      imageId,
      (cur) =>
        cur && {
          ...cur,
          presetId: null,
          layers: cur.layers.map((l) =>
            l.id === layer.id ? clampLayer({ ...l, ...p } as ShadowLayer) : l,
          ),
        },
      live,
    );
  const move = (by: -1 | 1) =>
    ed().setShadow(imageId, (cur) => {
      if (!cur) return cur;
      const from = cur.layers.findIndex((l) => l.id === layer.id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= cur.layers.length) return cur;
      const layers = [...cur.layers];
      [layers[from], layers[to]] = [layers[to]!, layers[from]!];
      return { ...cur, presetId: null, layers };
    });
  const commit = () => ed().commitShadow(imageId);
  const name = t.layerTypes[layer.type]!;
  const values = layer as unknown as Record<string, number>;

  return (
    <div
      className="rounded-md border border-border p-3"
      role="group"
      aria-label={name}
      data-testid="shadow-layer"
      data-layer-type={layer.type}
    >
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{name}</h4>
        <div className="flex">
          <button
            type="button"
            className={iconBtn}
            aria-label={t.moveUp(name)}
            title={t.moveUp(name)}
            disabled={disabled || index === 0}
            onClick={() => move(-1)}
          >
            <ChevronUp size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={iconBtn}
            aria-label={t.moveDown(name)}
            title={t.moveDown(name)}
            disabled={disabled || index === count - 1}
            onClick={() => move(1)}
          >
            <ChevronDown size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={iconBtn}
            aria-pressed={layer.visible}
            aria-label={layer.visible ? t.hide(name) : t.show(name)}
            title={layer.visible ? t.hide(name) : t.show(name)}
            disabled={disabled}
            onClick={() => patch({ visible: !layer.visible }, false)}
          >
            {layer.visible ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
          </button>
          <button
            type="button"
            className={iconBtn}
            aria-label={t.remove(name)}
            title={t.remove(name)}
            disabled={disabled}
            onClick={() =>
              ed().setShadow(
                imageId,
                (cur) => cur && { ...cur, layers: cur.layers.filter((l) => l.id !== layer.id) },
              )
            }
          >
            <Trash2 size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        {FIELDS[layer.type].map((f) => {
          const k = f.scale ?? 1;
          return (
            <SliderRow
              key={f.key}
              label={f.label}
              value={Math.round(values[f.key]! * k)}
              min={f.min}
              max={f.max}
              disabled={disabled}
              onChange={(v) => patch({ [f.key]: v / k } as Partial<ShadowLayer>, true)}
              onCommit={commit}
            />
          );
        })}
        {layer.type !== 'reflection' && (
          <div className="grid grid-cols-[76px_1fr] items-start gap-3">
            <span className="pt-1 text-sm">{t.colour}</span>
            <ColorField
              value={layer.color}
              disabled={disabled}
              onChange={(hex) => patch({ color: hex }, true)}
              onCommit={commit}
              pickLabel={t.pickColour}
              hexLabel={t.hexLabel}
              recentLabel={t.recentColours}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The Shadow tab of the Properties panel. */
export function ShadowPanel() {
  const id = useEditorStore((s) => s.activeId);
  const state = useActiveState();
  const hasMask = useProjectStore((s) => (id ? !!s.masks[id] : false));
  const ed = useEditorStore.getState;
  const shadow: ShadowState | null = state?.shadow ?? null;
  const enabled = shadow?.enabled === true;
  // Controls need an image with a cut-out, and an enabled shadow.
  const locked = !id || !state || !hasMask;
  const inactive = locked || !enabled;
  const full = (shadow?.layers.length ?? 0) >= L.maxLayers;
  const needsGround = !!shadow?.layers.some(usesGround);
  const guides = useEditorStore((s) => s.showShadowGuides);
  const shadowOnly = useEditorStore((s) => s.shadowOnly);
  const imageCount = useProjectStore((s) => s.images.length);

  const toggle = (on: boolean) => {
    if (!id) return;
    ed().setShadow(id, (cur) => (cur ? { ...cur, enabled: on } : on ? defaultShadow() : null));
  };

  return (
    <div className="flex flex-col gap-3 px-5 py-3" data-testid="shadow-panel">
      <Check2 checked={enabled} onChange={toggle} label={t.enable} disabled={locked} />

      {!locked ? null : (
        <div className="rounded-md border border-border bg-muted p-3 text-sm" role="status">
          <p>{t.needsCutout}</p>
          {id && state && (
            <button
              type="button"
              onClick={() => void removeBackground(id)}
              className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover"
            >
              {t.removeBg}
            </button>
          )}
        </div>
      )}

      <fieldset
        disabled={inactive}
        className={`flex min-w-0 flex-col gap-3 ${inactive ? 'opacity-60' : ''}`}
      >
        {id && state && (
          <ShadowPresets imageId={id} shadow={shadow} size={state.source} disabled={inactive} />
        )}

        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{t.layers}</h3>
          <Menu.Root>
            <Menu.Trigger
              disabled={inactive || full}
              title={full ? t.maxLayers(L.maxLayers) : undefined}
              aria-label={t.addMenu}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium hover:bg-border disabled:opacity-50"
            >
              <Plus size={14} aria-hidden /> {t.addLayer} <ChevronDown size={14} aria-hidden />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={6} className={menuContent}>
                {(['drop', 'contact', 'cast', 'reflection'] as LayerType[]).map((type) => (
                  <Menu.Item
                    key={type}
                    className={menuItem}
                    onSelect={() =>
                      id &&
                      ed().setShadow(id, (cur) =>
                        cur ? { ...cur, layers: [...cur.layers, newLayer(type)] } : cur,
                      )
                    }
                  >
                    <span className="font-medium">{t.layerTypes[type]}</span>
                    <span className="text-xs text-fg-muted">{t.layerHints[type]}</span>
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>

        {shadow && shadow.layers.length === 0 && (
          <p className="text-sm text-fg-muted">{t.noLayers}</p>
        )}
        {id &&
          shadow?.layers.map((layer, i) => (
            <LayerCard
              key={layer.id}
              layer={layer}
              imageId={id}
              disabled={inactive}
              index={i}
              count={shadow.layers.length}
            />
          ))}
        {shadow && shadow.layers.length > 1 && (
          <p className="text-xs text-fg-muted">{t.stackHint}</p>
        )}

        <div className="flex flex-col gap-2.5 border-t border-border pt-3">
          <h3 className="text-base font-semibold">{t.groundSection}</h3>
          <Check2
            checked={guides}
            disabled={inactive}
            label={t.showGuides}
            onChange={(v) => ed().setShowShadowGuides(v)}
          />
          <SliderRow
            label={t.groundY}
            value={Math.round((shadow?.groundY ?? 0.92) * 100)}
            min={0}
            max={100}
            disabled={inactive || !needsGround}
            onChange={(v) =>
              id &&
              ed().setShadow(id, (cur) => cur && { ...cur, presetId: null, groundY: v / 100 }, true)
            }
            onCommit={() => id && ed().commitShadow(id)}
          />
          <button
            type="button"
            disabled={inactive || !needsGround || shadow?.groundY == null}
            onClick={() =>
              id && ed().setShadow(id, (cur) => cur && { ...cur, presetId: null, groundY: null })
            }
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium hover:bg-border disabled:opacity-50"
          >
            {t.groundAuto}
          </button>
          <p className="text-xs text-fg-muted">{t.groundHint}</p>
        </div>

        <Check2
          checked={shadow?.autoExpand ?? true}
          disabled={inactive}
          label={t.autoExpand}
          hint={t.autoExpandHint}
          onChange={(v) => id && ed().setShadow(id, (cur) => cur && { ...cur, autoExpand: v })}
        />

        <Check2
          checked={shadow?.linearLight ?? false}
          disabled={inactive}
          label={t.linearLight}
          hint={t.linearLightHint}
          onChange={(v) => id && ed().setShadow(id, (cur) => cur && { ...cur, linearLight: v })}
        />

        <Check2
          checked={shadowOnly}
          disabled={inactive}
          label={t.shadowOnly}
          hint={t.shadowOnlyHint}
          onChange={(v) => ed().setShadowOnly(v)}
        />

        <button
          type="button"
          disabled={inactive}
          onClick={() => id && ed().resetShadow(id)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium hover:bg-border disabled:opacity-50"
        >
          <RotateCcw size={14} aria-hidden /> {t.reset}
        </button>

        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={inactive || (shadow?.layers.length ?? 0) === 0 || imageCount < 2}
            onClick={() => void applyShadowToAll()}
            className="inline-flex w-fit items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
          >
            <Copy size={14} aria-hidden /> {t.applyAll}
          </button>
          <p className="text-xs text-fg-muted">{t.applyAllHint}</p>
        </div>
      </fieldset>
    </div>
  );
}
