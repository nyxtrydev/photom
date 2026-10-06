import { create } from 'zustand';
import type { ImageMeta, MaskResult } from '@/types/dto';

const newProjectId = () => crypto.randomUUID();

interface ProjectState {
  /** Stable id used for autosave/recovery of this session's project. */
  projectId: string;
  /** Display name without extension. */
  name: string;
  /** Absolute path of the saved `.photom` file, or null while untitled. */
  path: string | null;
  dirty: boolean;
  images: ImageMeta[];
  masks: Record<string, MaskResult>;
  processing: Record<string, boolean>;
  addImages: (images: ImageMeta[]) => void;
  setMask: (mask: MaskResult) => void;
  setMaskFor: (id: string, mask: MaskResult | null) => void;
  removeImage: (id: string) => void;
  setProcessing: (id: string, on: boolean) => void;
  clearImages: () => void;
  setDirty: (dirty: boolean) => void;
  /** Replace the whole project (open/restore/new). */
  load: (p: {
    projectId?: string;
    name: string;
    path: string | null;
    images: ImageMeta[];
    masks: Record<string, MaskResult>;
    dirty: boolean;
  }) => void;
  setSaved: (name: string, path: string) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projectId: newProjectId(),
  name: 'Untitled',
  path: null,
  dirty: false,
  images: [],
  masks: {},
  processing: {},
  addImages: (incoming) =>
    set((s) => {
      const known = new Set(s.images.map((i) => i.id));
      return { images: [...s.images, ...incoming.filter((i) => !known.has(i.id))] };
    }),
  setMask: (mask) => set((s) => ({ masks: { ...s.masks, [mask.id]: mask } })),
  setMaskFor: (id, mask) =>
    set((s) => {
      const masks = { ...s.masks };
      if (mask) masks[id] = mask;
      else delete masks[id];
      return { masks };
    }),
  removeImage: (id) =>
    set((s) => {
      const masks = { ...s.masks };
      const processing = { ...s.processing };
      delete masks[id];
      delete processing[id];
      return { images: s.images.filter((i) => i.id !== id), masks, processing };
    }),
  setProcessing: (id, on) => set((s) => ({ processing: { ...s.processing, [id]: on } })),
  clearImages: () =>
    set({ images: [], masks: {}, processing: {}, name: 'Untitled', path: null, dirty: false }),
  setDirty: (dirty) => set({ dirty }),
  load: (p) =>
    set({
      projectId: p.projectId ?? newProjectId(),
      name: p.name,
      path: p.path,
      images: p.images,
      masks: p.masks,
      processing: {},
      dirty: p.dirty,
    }),
  setSaved: (name, path) => set({ name, path, dirty: false }),
}));
