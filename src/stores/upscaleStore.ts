import { create } from 'zustand';
import type { UpscaleEngine } from '@/types/dto';
import type { PendingUpscale, UpscaleParams } from '@/types/upscale';

export type ScaleChoice = 2 | 4 | 'custom';

/** What the Upscale tab shows for one image (never saved: only the kept result is). */
export interface UpscaleOptions {
  scale: ScaleChoice;
  target: { width: number; height: number };
  lockRatio: boolean;
  engine: UpscaleEngine;
  /** "Reduce artefacts": a light denoise before enlarging. */
  preDenoise: boolean;
}

export type UpscaleRun =
  | { phase: 'running'; jobId: string }
  | { phase: 'review'; pending: PendingUpscale }
  | { phase: 'error'; message: string };

interface UpscaleUiState {
  options: Record<string, UpscaleOptions>;
  runs: Record<string, UpscaleRun>;
  /** The image's own options, or sensible defaults (4x, custom target twice the size). */
  optionsFor: (id: string, source: { width: number; height: number }) => UpscaleOptions;
  setOptions: (
    id: string,
    source: { width: number; height: number },
    o: Partial<UpscaleOptions>,
  ) => void;
  setRun: (id: string, run: UpscaleRun) => void;
  clearRun: (id: string) => void;
}

export const defaultOptions = (source: { width: number; height: number }): UpscaleOptions => ({
  scale: 2,
  target: { width: source.width * 2, height: source.height * 2 },
  lockRatio: true,
  engine: 'standard',
  preDenoise: false,
});

export const useUpscaleStore = create<UpscaleUiState>((set, get) => ({
  options: {},
  runs: {},
  optionsFor: (id, source) => get().options[id] ?? defaultOptions(source),
  setOptions: (id, source, o) =>
    set((st) => ({
      options: { ...st.options, [id]: { ...(st.options[id] ?? defaultOptions(source)), ...o } },
    })),
  setRun: (id, run) => set((st) => ({ runs: { ...st.runs, [id]: run } })),
  clearRun: (id) =>
    set((st) => {
      const { [id]: _gone, ...rest } = st.runs;
      void _gone;
      return { runs: rest };
    }),
}));

/** The request the options describe. */
export function paramsFrom(o: UpscaleOptions): UpscaleParams {
  const extra = o.preDenoise ? { preDenoise: true } : {};
  return o.scale === 'custom'
    ? { target: { ...o.target }, engine: o.engine, ...extra }
    : { scale: o.scale, engine: o.engine, ...extra };
}

/** The model scale (2x or 4x) that reaches a result of `out` pixels from `src`. */
export function modelScaleFor(
  src: { width: number; height: number },
  out: { width: number; height: number },
): 2 | 4 {
  return Math.max(out.width / src.width, out.height / src.height) <= 2 ? 2 : 4;
}
