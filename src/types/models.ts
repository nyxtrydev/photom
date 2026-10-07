/** Mirrors `src-tauri/src/model_hub` (hub.rs, registry.rs). Keep in sync. */
export type ModelStateKind =
  | 'notInstalled'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'installing'
  | 'installed'
  | 'updateAvailable'
  | 'removing'
  | 'failed';

export type ModelState =
  { kind: Exclude<ModelStateKind, 'failed'> } | { kind: 'failed'; code: string; message: string };

export type ModelSource = 'bundled' | 'hub' | 'imported';

export interface ModelLicense {
  name: string;
  url: string;
  commercialUse: boolean;
  attribution: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  feature: string;
  version: string;
  description: string;
  sizeBytes: number;
  sha256: string;
  license: ModelLicense;
  requirements: { minRamMb: number; gpuOptional: boolean };
  recommended: boolean;
  dependsOn: string[];
  state: ModelState;
  installedVersion: string | null;
  source: ModelSource | null;
  verified: boolean;
  installable: boolean;
  removable: boolean;
}

export interface CatalogStatus {
  source: 'remote' | 'bundled';
  generatedAt: string;
  warning: string | null;
}

export interface RefreshResult extends CatalogStatus {
  models: ModelInfo[];
}

export interface ModelProgress {
  id: string;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
}

export interface ModelStateEvent {
  id: string;
  state: ModelState;
}

export interface ModelErrorEvent {
  id: string;
  code: string;
  message: string;
}
