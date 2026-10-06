import { create } from 'zustand';
import type { ExportItemRequest } from '@/api/export';
import type { ExportOptionsApi, JobSnapshot } from '@/types/export';

/** What was started, kept so failed items can be retried. */
export interface JobRequest {
  kind: 'export' | 'removeBackground';
  items: ExportItemRequest[];
  options?: ExportOptionsApi;
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
