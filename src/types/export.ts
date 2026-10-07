import type { MaskResult } from './dto';

export type ExportScope = 'current' | 'all';
export type BackgroundMode = 'transparent' | 'keepSelected';
export type SizeMode = 'original' | 'custom';

/** UI-level export options (the dialog edits these). `scope` and `lockRatio` never reach the backend. */
export interface ExportOptionsUi {
  scope: ExportScope;
  background: BackgroundMode;
  size: {
    mode: SizeMode;
    width: number;
    height: number;
    lockRatio: boolean;
    /** Optional cap on the longest side in pixels (never upscales). */
    maxSide: number | null;
  };
  crop: { enabled: boolean; padding: number };
  /** 0 (fastest) to 9 (smallest). */
  compression: number;
  filenameTemplate: string;
  folder: string;
  /** Bake each image's shadow into the exported picture. */
  includeShadow: boolean;
  /** Also write the shadow alone (`name-photom-shadow.png`) on a matching transparent canvas. */
  shadowLayer: boolean;
}

/** What `export_png` receives (mirrors `ExportOptions` in services/exporter.rs). */
export interface ExportOptionsApi {
  background: BackgroundMode;
  size: { mode: SizeMode; width: number; height: number; maxSide: number | null };
  crop: { enabled: boolean; padding: number };
  compression: number;
  filenameTemplate: string;
  folder: string;
  includeShadow: boolean;
  shadowLayer: boolean;
}

export interface ExportPreset {
  id: string;
  name: string;
  /** Option fields a preset controls. Folder, scope and filename are never part of a preset. */
  options: PresetOptions;
  builtIn?: boolean;
}

export interface PresetOptions {
  background: BackgroundMode;
  sizeMode: SizeMode;
  maxSide: number | null;
  crop: { enabled: boolean; padding: number };
  compression: number;
}

export const DEFAULT_TEMPLATE = '{name}-photom.png';

export const DEFAULT_EXPORT_OPTIONS: ExportOptionsUi = {
  scope: 'current',
  background: 'transparent',
  size: { mode: 'original', width: 0, height: 0, lockRatio: true, maxSide: null },
  crop: { enabled: false, padding: 0 },
  compression: 6,
  filenameTemplate: DEFAULT_TEMPLATE,
  folder: '',
  includeShadow: true,
  shadowLayer: false,
};

export const BUILT_IN_PRESETS: ExportPreset[] = [
  {
    id: 'web',
    name: 'Web',
    builtIn: true,
    options: {
      background: 'transparent',
      sizeMode: 'original',
      maxSide: 2000,
      crop: { enabled: false, padding: 0 },
      compression: 9,
    },
  },
  {
    id: 'print',
    name: 'Print',
    builtIn: true,
    options: {
      background: 'transparent',
      sizeMode: 'original',
      maxSide: null,
      crop: { enabled: false, padding: 0 },
      compression: 3,
    },
  },
  {
    id: 'original',
    name: 'Original',
    builtIn: true,
    options: {
      background: 'transparent',
      sizeMode: 'original',
      maxSide: null,
      crop: { enabled: false, padding: 0 },
      compression: 6,
    },
  },
];

export function applyPreset(base: ExportOptionsUi, preset: PresetOptions): ExportOptionsUi {
  return {
    ...base,
    background: preset.background,
    size: { ...base.size, mode: preset.sizeMode, maxSide: preset.maxSide },
    crop: { ...preset.crop },
    compression: preset.compression,
  };
}

export function presetFrom(options: ExportOptionsUi): PresetOptions {
  return {
    background: options.background,
    sizeMode: options.size.mode,
    maxSide: options.size.maxSide,
    crop: { ...options.crop },
    compression: options.compression,
  };
}

/** Strip UI-only fields. */
export function toApiOptions(o: ExportOptionsUi): ExportOptionsApi {
  return {
    background: o.background,
    size: {
      mode: o.size.mode,
      width: o.size.width,
      height: o.size.height,
      maxSide: o.size.maxSide,
    },
    crop: o.crop,
    compression: o.compression,
    filenameTemplate: o.filenameTemplate,
    folder: o.folder,
    includeShadow: o.includeShadow,
    shadowLayer: o.shadowLayer,
  };
}

// ---- jobs & history -------------------------------------------------------------------------

export type ItemStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';
export type JobStatus = 'running' | 'paused' | 'done' | 'cancelled';
export type JobKind = 'export' | 'removeBackground' | 'applyShadow' | 'upscale' | 'upscaleBatch';

export interface JobItem {
  id: string;
  label: string;
  status: ItemStatus;
  error: { code: string; message: string } | null;
  result: unknown;
}

export interface JobSnapshot {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  done: number;
  total: number;
  items: JobItem[];
}

export interface ExportedItem {
  id: string;
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
}

export interface JobEventBase {
  jobId: string;
}
export interface JobItemComplete extends JobEventBase {
  itemId: string;
  result: unknown;
}

export type HistoryKind = 'export' | 'project' | 'shadow' | 'upscale';
export interface HistoryItem {
  id: string;
  kind: HistoryKind;
  name: string;
  timestamp: string;
  sourcePath: string | null;
  outputPath: string | null;
  thumbnail: string | null;
}

export type { MaskResult };
