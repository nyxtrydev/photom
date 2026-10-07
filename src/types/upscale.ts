import type { UpscaleEngine } from './dto';

/** What the user asked for (mirrors `UpscaleParams` in services/upscale.rs). */
export interface UpscaleParams {
  scale?: 2 | 4;
  target?: { width: number; height: number };
  engine: UpscaleEngine;
  preDenoise?: boolean;
}

export interface UpscaleWarning {
  code: string;
  message: string;
  blocking: boolean;
}

export interface UpscaleEstimate {
  outW: number;
  outH: number;
  megapixels: number;
  etaSeconds: number;
  memoryMb: number;
  warnings: UpscaleWarning[];
}

/** A finished result waiting for Keep or Discard. */
export interface PendingUpscale {
  id: string;
  path: string;
  width: number;
  height: number;
  scale: 2 | 4 | null;
  engine: UpscaleEngine;
}
