import { create } from 'zustand';
import type { ExportItemRequest } from '@/api/export';
import type { ShadowState } from '@/canvas/shadow';
import type { ExportOptionsApi, JobSnapshot } from '@/types/export';
import type { UpscaleParams } from '@/types/upscale';

/** What was started, kept so failed items can be retried. */
export interface JobRequest {
  kind: 'export' | 'removeBackground' | 'applyShadow' | 'upscale' | 'upscaleBatch';
  items: ExportItemRequest[];
  /** applyShadow: the shadow each image takes once its check passes. */
  shadows?: Record<string, ShadowState>;
  label?: string;
  options?: ExportOptionsApi;
  /** upscaleBatch: the settings every image was started with (for retry). */
  upscaleParams?: UpscaleParams;
}

interface QueueState {
  /** Snapshots from the backend (source of truth), by job id. */
  jobs: Record<string, JobSnapshot>;
  requests: Record<string, JobRequest>;
  /** Job shown in the batch progress dialog. */
  dialogJobId: string | null;
  /** Jobs whose completion has already been reported (summary toast). */
  reported: Record<string, true>;
  setSnapshot: (s: JobSnapshot) => void;
  setRequest: (jobId: string, r: JobRequest) => void;
  openDialog: (jobId: string | null) => void;
  markReported: (jobId: string) => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  jobs: {},
  requests: {},
  dialogJobId: null,
  reported: {},
  setSnapshot: (s) => set((st) => ({ jobs: { ...st.jobs, [s.jobId]: s } })),
  setRequest: (jobId, r) => set((st) => ({ requests: { ...st.requests, [jobId]: r } })),
  openDialog: (dialogJobId) => set({ dialogJobId }),
  markReported: (jobId) => set((st) => ({ reported: { ...st.reported, [jobId]: true } })),
}));

export const isFinished = (s: JobSnapshot | undefined) =>
  !!s && (s.status === 'done' || s.status === 'cancelled');
