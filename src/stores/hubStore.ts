import { create } from 'zustand';
import type {
  CatalogStatus,
  ModelInfo,
  ModelProgress,
  ModelState,
  ModelStateKind,
} from '@/types/models';

interface HubState {
  models: Record<string, ModelInfo>;
  /** Catalog order, for stable lists. */
  order: string[];
  catalog: CatalogStatus | null;
  progress: Record<string, ModelProgress>;
  /** True after the first `models_list` answered. */
  loaded: boolean;
  setModels: (list: ModelInfo[]) => void;
  setCatalog: (c: CatalogStatus | null) => void;
  setState: (id: string, state: ModelState) => void;
  setProgress: (p: ModelProgress) => void;
}

export const useHubStore = create<HubState>((set) => ({
  models: {},
  order: [],
  catalog: null,
  progress: {},
  loaded: false,
  setModels: (list) =>
    set((s) => {
      // Keep progress only for models that are still being worked on.
      const progress: Record<string, ModelProgress> = {};
      for (const m of list) {
        const p = s.progress[m.id];
        if (p && (isActive(m.state.kind) || m.state.kind === 'paused')) progress[m.id] = p;
      }
      return {
        models: Object.fromEntries(list.map((m) => [m.id, m])),
        order: list.map((m) => m.id),
        progress,
        loaded: true,
      };
    }),
  setCatalog: (catalog) => set({ catalog }),
  setState: (id, state) =>
    set((s) => {
      const m = s.models[id];
      if (!m) return s;
      const progress = { ...s.progress };
      if (state.kind === 'notInstalled' || state.kind === 'installed' || state.kind === 'failed') {
        delete progress[id];
      }
      return { models: { ...s.models, [id]: { ...m, state } }, progress };
    }),
  setProgress: (p) => set((s) => ({ progress: { ...s.progress, [p.id]: p } })),
}));

/** Work is under way (not just paused or finished). */
export const isActive = (k: ModelStateKind) =>
  k === 'queued' || k === 'downloading' || k === 'verifying' || k === 'installing';

/** Usable right now (an older version stays usable while an update is available). */
export const isUsable = (m: ModelInfo) =>
  m.state.kind === 'installed' || m.state.kind === 'updateAvailable';

/** Models a feature needs: its recommended models plus everything they depend on (as in Rust). */
export function requiredFor(models: Record<string, ModelInfo>, feature: string): ModelInfo[] {
  const all = Object.values(models);
  const wanted = all.filter((m) => m.feature === feature && m.recommended).map((m) => m.id);
  const seen = new Set(wanted);
  for (let i = 0; i < wanted.length; i++) {
    for (const dep of models[wanted[i]!]?.dependsOn ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        wanted.push(dep);
      }
    }
  }
  return wanted.map((id) => models[id]).filter((m): m is ModelInfo => !!m);
}
