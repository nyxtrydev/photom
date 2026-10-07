import { Loader2, Maximize, Minus, Plus } from 'lucide-react';
import * as Slider from '@radix-ui/react-slider';
import { ModelDownloadChip } from '@/components/ModelDownloadChip';
import { fitView, setZoom, zoomStep } from '@/app/viewActions';
import { MAX_ZOOM, MIN_ZOOM } from '@/canvas/viewport';
import { strings } from '@/i18n/strings';
import { useActiveState, useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';
import { useUpscaleStore } from '@/stores/upscaleStore';

const s = strings.editor.status;
const small =
  'flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-surface hover:bg-muted disabled:opacity-40';

// Slider is linear in log(zoom) so each step feels equal.
const RANGE = Math.log(MAX_ZOOM / MIN_ZOOM);
const toSlider = (zoom: number) => (Math.log(zoom / MIN_ZOOM) / RANGE) * 100;
const fromSlider = (v: number) => MIN_ZOOM * Math.exp((v / 100) * RANGE);

export function EditorStatusBar() {
  const state = useActiveState();
  const id = useEditorStore((st) => st.activeId);
  const busy = useProjectStore((st) => (id ? st.processing[id] === true : false));
  const upscaling = useUpscaleStore((st) => (id ? st.runs[id]?.phase === 'running' : false));
  const autosaved = useUiStore((st) => st.lastAutosave);
  const zoom = state?.viewport?.zoom ?? 1;
  const off = !state?.viewport;

  return (
    <footer className="flex h-14 shrink-0 items-center gap-4 border-t border-border bg-surface px-5 text-sm">
      <span className="tabular-nums">
        {s.zoom} <span className="ml-1 inline-block w-12">{Math.round(zoom * 100)}%</span>
      </span>
      <button
        type="button"
        aria-label={s.zoomOut}
        className={small}
        disabled={off}
        onClick={() => zoomStep(-1)}
      >
        <Minus size={16} />
      </button>
      <Slider.Root
        className="relative flex h-5 w-44 items-center"
        min={0}
        max={100}
        step={0.5}
        value={[toSlider(zoom)]}
        disabled={off}
        onValueChange={([v]) => v !== undefined && setZoom(fromSlider(v))}
        aria-label={s.zoomSlider}
      >
        <Slider.Track className="relative h-1 grow rounded-full bg-border">
          <Slider.Range className="absolute h-full rounded-full bg-primary" />
        </Slider.Track>
        <Slider.Thumb
          aria-label={s.zoomSlider}
          className="block h-4 w-4 rounded-full border-2 border-surface bg-primary shadow-card"
        />
      </Slider.Root>
      <button
        type="button"
        aria-label={s.zoomIn}
        className={small}
        disabled={off}
        onClick={() => zoomStep(1)}
      >
        <Plus size={16} />
      </button>
      <button type="button" aria-label={s.fit} className={small} disabled={off} onClick={fitView}>
        <Maximize size={15} />
      </button>

      <span className="ml-8 text-fg-muted">
        {state
          ? state.upscale
            ? `${state.upscale.width} × ${state.upscale.height} (${strings.upscale.upscaledTag})`
            : `${state.source.width} × ${state.source.height}`
          : s.noImage}
      </span>
      <span className="text-border" aria-hidden>
        |
      </span>
      <span className="text-fg-muted">{s.rgb}</span>
      {autosaved && (
        <>
          <span className="text-border" aria-hidden>
            |
          </span>
          <span className="text-fg-muted">{s.autosaved(autosaved)}</span>
        </>
      )}

      <span role="status" aria-live="polite" className="ml-auto flex items-center gap-2">
        {(busy || upscaling) && (
          <>
            <Loader2 size={18} className="animate-spin text-primary" aria-hidden />
            {upscaling ? strings.upscale.status : s.processing}
          </>
        )}
      </span>
      <ModelDownloadChip />
    </footer>
  );
}
