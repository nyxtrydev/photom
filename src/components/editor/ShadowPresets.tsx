import { Pencil, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { deleteShadowPreset, saveShadowPreset } from '@/api/shadow';
import { reportError } from '@/app/errors';
import {
  allShadowPresets,
  longestSide,
  presetFromShadow,
  shadowFromPreset,
  type ShadowPreset,
} from '@/canvas/shadowPresets';
import type { ShadowState } from '@/canvas/shadow';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

const t = strings.shadow;

const chip =
  'rounded-full border px-3 py-1.5 text-sm font-medium disabled:opacity-50 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-contrast border-border bg-muted hover:bg-border';
const small =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium hover:bg-border disabled:opacity-50';

/** Preset chips (built-in and custom), plus save / rename / delete for custom ones. */
export function ShadowPresets({
  imageId,
  shadow,
  size,
  disabled,
}: {
  imageId: string;
  shadow: ShadowState | null;
  size: { width: number; height: number };
  disabled: boolean;
}) {
  const custom = useSettingsStore((s) => s.shadowPresets);
  const presets = useMemo(() => allShadowPresets(custom), [custom]);
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  const selected = presets.find((p) => p.id === shadow?.presetId) ?? null;
  const side = longestSide(size);
  const canSave = !!shadow && shadow.layers.length > 0;

  const apply = (p: ShadowPreset) =>
    useEditorStore.getState().setShadow(imageId, (cur) => shadowFromPreset(p, side, cur));

  const store = async (p: ShadowPreset) => {
    try {
      const list = await saveShadowPreset({
        id: p.id,
        name: p.name,
        refSide: p.refSide,
        autoExpand: p.autoExpand,
        layers: p.layers,
      });
      useSettingsStore.setState({ shadowPresets: list });
      return list;
    } catch (e) {
      reportError(e);
      return null;
    }
  };

  const commitName = async () => {
    if (!naming || !shadow) return;
    const name = naming.name.trim();
    if (!name) return;
    const existing = naming.id ? presets.find((p) => p.id === naming.id) : null;
    const preset = existing ? { ...existing, name } : presetFromShadow(name, shadow, side);
    const list = await store(preset);
    setNaming(null);
    if (!list) return;
    const saved =
      existing ?? list.find((p) => p.name === name && !presets.some((q) => q.id === p.id));
    // A new preset becomes the active one, so the chip row shows what was just saved.
    if (!existing && saved) {
      useEditorStore.getState().setShadow(imageId, (cur) => cur && { ...cur, presetId: saved.id });
    }
    useUiStore.getState().notify('success', t.presetSaved(name));
  };

  const remove = async (p: ShadowPreset) => {
    try {
      const list = await deleteShadowPreset(p.id);
      useSettingsStore.setState({ shadowPresets: list });
      useEditorStore
        .getState()
        .setShadow(imageId, (cur) =>
          cur && cur.presetId === p.id ? { ...cur, presetId: null } : cur,
        );
      useUiStore.getState().notify('info', t.presetDeleted(p.name));
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="shadow-presets">
      <h3 className="text-base font-semibold" id="shadow-presets-label">
        {t.presets}
      </h3>
      <div role="group" aria-labelledby="shadow-presets-label" className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={shadow?.presetId === p.id}
            disabled={disabled}
            className={chip}
            onClick={() => apply(p)}
          >
            {p.name}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={!!shadow && shadow.presetId === null}
          disabled
          className={chip}
          title={t.custom}
        >
          {t.custom}
        </button>
      </div>
      <p className="text-xs text-fg-muted">{t.presetAppliesHint}</p>

      {naming ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void commitName();
          }}
        >
          <input
            autoFocus
            value={naming.name}
            maxLength={60}
            aria-label={t.presetName}
            onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-sm"
          />
          <button type="submit" className={small} disabled={!naming.name.trim()}>
            {t.presetSave}
          </button>
          <button type="button" className={small} onClick={() => setNaming(null)}>
            {t.presetCancel}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={small}
            disabled={disabled || !canSave}
            onClick={() => setNaming({ id: '', name: '' })}
          >
            <Save size={14} aria-hidden /> {t.savePreset}
          </button>
          {selected && !selected.builtIn && (
            <>
              <button
                type="button"
                className={small}
                disabled={disabled}
                onClick={() => setNaming({ id: selected.id, name: selected.name })}
              >
                <Pencil size={14} aria-hidden /> {t.renamePreset}
              </button>
              <button
                type="button"
                className={small}
                disabled={disabled}
                aria-label={`${t.deletePreset}: ${selected.name}`}
                onClick={() => void remove(selected)}
              >
                <Trash2 size={14} aria-hidden /> {t.deletePreset}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
