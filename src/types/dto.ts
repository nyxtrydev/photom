/** Mirrors `models/dto.rs`. Keep in sync. */
export interface PingResponse {
  message: string;
  appVersion: string;
  timestamp: string;
}

export interface ImageMeta {
  id: string;
  path: string;
  name: string;
  width: number;
  height: number;
  format: string;
  thumbnailPath: string;
}

export interface RejectedFile {
  path: string;
  reason: string;
}

export interface ImportResult {
  images: ImageMeta[];
  rejected: RejectedFile[];
}

export type ModelKind = 'fast' | 'quality';
export type DevicePref = 'cpu' | 'gpuIfAvailable';
export type DeviceUsed = 'cpu' | 'gpu';

export interface RemoveOptions {
  model: ModelKind;
  device: DevicePref;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskResult {
  id: string;
  maskPath: string;
  width: number;
  height: number;
  boundingBox: BoundingBox | null;
  durationMs: number;
  device: DeviceUsed;
}

export type ModelState = 'missing' | 'idle' | 'loading' | 'loaded' | 'error';

export interface ModelStatus {
  ready: boolean;
  state: ModelState;
  activeModel: ModelKind;
  device: DeviceUsed;
  path: string | null;
  message: string | null;
}

export interface WorkingSet {
  id: string;
  previewPath: string;
  maskPath: string | null;
  workWidth: number;
  workHeight: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface BackgroundImage {
  cachePath: string;
  sourcePath: string;
  width: number;
  height: number;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface RecentProject {
  path: string;
  name: string;
  modified: string;
  thumbnail: string | null;
}

/** Mirrors `services/settings.rs`. */
export interface Settings {
  schemaVersion: number;
  theme: ThemeMode;
  autosaveSeconds: number;
  recentProjectsLimit: number;
  defaultExportFolder: string | null;
  modelType: ModelKind;
  processing: DevicePref;
  shortcuts: Record<string, string[]>;
  exportPresets: unknown[];
  defaultPreset: string | null;
  lastUsedFolders: Record<string, string>;
  undoDepth: number;
  pixelLimitMp: number;
  embedOriginals: boolean;
  exportConcurrency: number;
  recentProjects: RecentProject[];
}

export interface ProjectImagePayload {
  id: string;
  state: unknown;
  backgroundSource: string | null;
}

export interface ProjectPayload {
  projectId: string;
  name: string;
  activeId: string | null;
  originalPath: string | null;
  images: ProjectImagePayload[];
}

export interface ProjectMeta {
  projectId: string;
  name: string;
  path: string | null;
  modified: string;
  formatVersion: number;
  activeId: string | null;
}

export interface OpenedImage {
  meta: ImageMeta;
  state: unknown;
  mask: MaskResult | null;
}

export interface OpenedProject {
  meta: ProjectMeta;
  images: OpenedImage[];
  warnings: string[];
}

export interface RecoveryEntry {
  id: string;
  name: string;
  savedAt: string;
  originalPath: string | null;
  imageCount: number;
}

export interface ModelInfo {
  kind: ModelKind;
  fileName: string;
  licence: string;
  present: boolean;
  path: string | null;
}

export interface AppInfo {
  version: string;
  logsDir: string;
  models: ModelInfo[];
}
