import { create } from 'zustand';
import type { Stroke } from '@/canvas/brush';
import { DEFAULT_BRUSH } from '@/canvas/brush';
import { DEFAULT_REFINE, type RefineParams } from '@/canvas/maskOps';
import type { Viewport } from '@/canvas/viewport';
import type { BackgroundImage, MaskResult } from '@/types/dto';
import { useSettingsStore } from './settingsStore';

export type Tool = 'move' | 'keep' | 'erase' | 'pan' | 'zoom';
export type BackgroundKind = 'transparent' | 'solid' | 'image';
export type FitMode = 'cover' | 'contain' | 'stretch';
export type CompareMode = 'split' | 'after';

export interface BackgroundState {
  kind: BackgroundKind;
  color: string;
  image: BackgroundImage | null;
  fit: FitMode;
}

export interface OutputState {
  width: number;
  height: number;
  lockRatio: boolean;
  cropToSubject: boolean;
}

export type Command =
  | { type: 'stroke'; stroke: Stroke }
  | { type: 'clearEdits'; strokes: Stroke[] }
  | { type: 'refine'; before: RefineParams; after: RefineParams }
  | { type: 'background'; before: BackgroundState; after: BackgroundState }
  | { type: 'output'; before: OutputState; after: OutputState }
  | { type: 'rerun'; before: MaskResult | null; after: MaskResult };

export interface ImageEditState {
  /** Source image size in pixels. */
  source: { width: number; height: number };
  refine: RefineParams;
  background: BackgroundState;
  output: OutputState;
  /** Brush edits as stroke deltas (not bitmaps). */
  strokes: Stroke[];
  /** Bumped whenever `strokes` changes other than by live painting. */
  editRev: number;
  /** Bumped whenever the base model mask changes (re-run, undo/redo of a re-run). */
  maskRev: number;
  undo: Command[];
  redo: Command[];
  /** Before/After divider as a fraction of image width. */
  split: number;
  viewport: Viewport | null;
  /** True while the view tracks "fit to screen" (cleared by manual zoom/pan). */
  fit: boolean;
  pendingRefineBefore: RefineParams | null;
  lastMergeAt: number;
}

export const DEFAULT_BACKGROUND: BackgroundState = {
  kind: 'transparent',
  color: '#ffffff',
  image: null,
  fit: 'cover',
};

const MERGE_WINDOW_MS = 800;

export const newImageState = (width: number, height: number): ImageEditState => ({
  source: { width, height },
  refine: { ...DEFAULT_REFINE },
  background: { ...DEFAULT_BACKGROUND },
  output: { width, height, lockRatio: true, cropToSubject: false },
  strokes: [],
  editRev: 0,
  maskRev: 0,
  undo: [],
  redo: [],
  split: 0.5,
  viewport: null,
  fit: true,
  pendingRefineBefore: null,
  lastMergeAt: 0,
});

interface EditorState {
  activeId: string | null;
  tool: Tool;
  brush: { size: number; hardness: number };
  compare: CompareMode;
  showChecker: boolean;
  recentColors: string[];
  states: Record<string, ImageEditState>;
  viewSize: { width: number; height: number };

  setActive: (id: string | null) => void;
  setTool: (tool: Tool) => void;
  setBrush: (patch: Partial<{ size: number; hardness: number }>) => void;
  setCompare: (mode: CompareMode) => void;
  toggleChecker: () => void;
  addRecentColor: (hex: string) => void;

  ensureState: (id: string, width: number, height: number) => void;
  dropState: (id: string) => void;
  /** Replace every image's state at once (open/restore/new project). */
  replaceAll: (states: Record<string, ImageEditState>, activeId: string | null) => void;
  setViewport: (id: string, vp: Viewport, fit?: boolean) => void;
  setViewSize: (width: number, height: number) => void;
  setSplit: (id: string, split: number) => void;

  setRefine: (id: string, patch: Partial<RefineParams>) => void;
  commitRefine: (id: string) => void;
  resetRefine: (id: string) => void;
  setBackground: (id: string, patch: Partial<BackgroundState>) => void;
  setOutput: (id: string, patch: Partial<OutputState>) => void;
  addStroke: (id: string, stroke: Stroke) => void;
  clearEdits: (id: string) => void;
  recordRerun: (id: string, before: MaskResult | null, after: MaskResult) => void;

  /** Pure state part of undo/redo. Returns the command so callers can run side effects. */
  undo: (id: string) => Command | null;
  redo: (id: string) => Command | null;
}

const withState = (
  states: Record<string, ImageEditState>,
  id: string,
  fn: (s: ImageEditState) => ImageEditState,
) => {
  const cur = states[id];
  return cur ? { ...states, [id]: fn(cur) } : states;
};

const push = (s: ImageEditState, cmd: Command, now = Date.now()): ImageEditState => {
  const depth = Math.max(1, useSettingsStore.getState().undoDepth);
  return { ...s, undo: [...s.undo, cmd].slice(-depth), redo: [], lastMergeAt: now };
};

/** Merge consecutive same-type edits (typing, colour dragging) into a single undo step. */
function pushOrMerge(
  s: ImageEditState,
  cmd: Extract<Command, { type: 'background' | 'output' }>,
): ImageEditState {
  const now = Date.now();
  const last = s.undo[s.undo.length - 1];
  if (last && last.type === cmd.type && now - s.lastMergeAt < MERGE_WINDOW_MS) {
    const merged = { ...last, after: cmd.after } as Command;
    return { ...s, undo: [...s.undo.slice(0, -1), merged], redo: [], lastMergeAt: now };
  }
  return push(s, cmd, now);
}

/** Apply a command in the given direction on state only (side effects live in actions). */
function apply(s: ImageEditState, cmd: Command, dir: 'undo' | 'redo'): ImageEditState {
  const undo = dir === 'undo';
  switch (cmd.type) {
    case 'stroke':
      return {
        ...s,
        strokes: undo ? s.strokes.slice(0, -1) : [...s.strokes, cmd.stroke],
        editRev: s.editRev + 1,
      };
    case 'clearEdits':
      return { ...s, strokes: undo ? cmd.strokes : [], editRev: s.editRev + 1 };
    case 'refine':
      return { ...s, refine: undo ? cmd.before : cmd.after };
    case 'background':
      return { ...s, background: undo ? cmd.before : cmd.after };
    case 'output':
      return { ...s, output: undo ? cmd.before : cmd.after };
    case 'rerun':
      return { ...s, maskRev: s.maskRev + 1 };
  }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  activeId: null,
  tool: 'move',
  brush: { ...DEFAULT_BRUSH },
  compare: 'split',
  showChecker: true,
  recentColors: [],
  states: {},
  viewSize: { width: 0, height: 0 },

  setActive: (activeId) => set({ activeId }),
  setTool: (tool) => set({ tool }),
  setBrush: (patch) => set((st) => ({ brush: { ...st.brush, ...patch } })),
  setCompare: (compare) => set({ compare }),
  toggleChecker: () => set((st) => ({ showChecker: !st.showChecker })),
  addRecentColor: (hex) =>
    set((st) => ({
      recentColors: [hex, ...st.recentColors.filter((c) => c !== hex)].slice(0, 6),
    })),

  ensureState: (id, width, height) =>
    set((st) =>
      st.states[id] ? st : { states: { ...st.states, [id]: newImageState(width, height) } },
    ),
  replaceAll: (states, activeId) => set({ states, activeId }),
  dropState: (id) =>
    set((st) => {
      const rest = { ...st.states };
      delete rest[id];
      return { states: rest };
    }),
  setViewport: (id, viewport, fit = false) =>
    set((st) => ({ states: withState(st.states, id, (s) => ({ ...s, viewport, fit })) })),
  setViewSize: (width, height) => set({ viewSize: { width, height } }),
  setSplit: (id, split) =>
    set((st) => ({
      states: withState(st.states, id, (s) => ({ ...s, split: Math.min(1, Math.max(0, split)) })),
    })),

  setRefine: (id, patch) =>
    set((st) => ({
      states: withState(st.states, id, (s) => ({
        ...s,
        pendingRefineBefore: s.pendingRefineBefore ?? s.refine,
        refine: { ...s.refine, ...patch },
      })),
    })),
  commitRefine: (id) =>
    set((st) => ({
      states: withState(st.states, id, (s) => {
        const before = s.pendingRefineBefore;
        if (!before) return s;
        const same =
          before.threshold === s.refine.threshold &&
          before.feather === s.refine.feather &&
          before.edgeShift === s.refine.edgeShift;
        const cleared = { ...s, pendingRefineBefore: null };
        return same ? cleared : push(cleared, { type: 'refine', before, after: s.refine });
      }),
    })),
  resetRefine: (id) =>
    set((st) => ({
      states: withState(st.states, id, (s) => {
        const before = s.pendingRefineBefore ?? s.refine;
        const after = { ...DEFAULT_REFINE };
        const base = { ...s, refine: after, pendingRefineBefore: null };
        const same =
          before.threshold === after.threshold &&
          before.feather === after.feather &&
          before.edgeShift === after.edgeShift;
        return same ? base : push(base, { type: 'refine', before, after });
      }),
    })),
  setBackground: (id, patch) =>
    set((st) => ({
      states: withState(st.states, id, (s) => {
        const after = { ...s.background, ...patch };
        return pushOrMerge(
          { ...s, background: after },
          { type: 'background', before: s.background, after },
        );
      }),
    })),
  setOutput: (id, patch) =>
    set((st) => ({
      states: withState(st.states, id, (s) => {
        const after = { ...s.output, ...patch };
        return pushOrMerge({ ...s, output: after }, { type: 'output', before: s.output, after });
      }),
    })),
  addStroke: (id, stroke) =>
    set((st) => ({
      states: withState(st.states, id, (s) =>
        push({ ...s, strokes: [...s.strokes, stroke] }, { type: 'stroke', stroke }),
      ),
    })),
  clearEdits: (id) =>
    set((st) => ({
      states: withState(st.states, id, (s) =>
        s.strokes.length === 0
          ? s
          : push(
              { ...s, strokes: [], editRev: s.editRev + 1 },
              { type: 'clearEdits', strokes: s.strokes },
            ),
      ),
    })),
  recordRerun: (id, before, after) =>
    set((st) => ({
      states: withState(st.states, id, (s) =>
        push({ ...s, maskRev: s.maskRev + 1 }, { type: 'rerun', before, after }),
      ),
    })),

  undo: (id) => {
    const s = get().states[id];
    const cmd = s?.undo[s.undo.length - 1];
    if (!s || !cmd) return null;
    set((st) => ({
      states: withState(st.states, id, (cur) => ({
        ...apply(cur, cmd, 'undo'),
        undo: cur.undo.slice(0, -1),
        redo: [...cur.redo, cmd],
        pendingRefineBefore: null,
      })),
    }));
    return cmd;
  },
  redo: (id) => {
    const s = get().states[id];
    const cmd = s?.redo[s.redo.length - 1];
    if (!s || !cmd) return null;
    set((st) => ({
      states: withState(st.states, id, (cur) => ({
        ...apply(cur, cmd, 'redo'),
        redo: cur.redo.slice(0, -1),
        undo: [...cur.undo, cmd],
        pendingRefineBefore: null,
      })),
    }));
    return cmd;
  },
}));

/** Convenience selector for the active image's state. */
export const useActiveState = () =>
  useEditorStore((s) => (s.activeId ? (s.states[s.activeId] ?? null) : null));
