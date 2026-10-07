import { useMemo } from 'react';
import { cancelModel, installModels, pauseModel, resumeModel } from '@/app/modelActions';
import { isActive, isUsable, requiredFor, useHubStore } from '@/stores/hubStore';
import type { ModelInfo } from '@/types/models';

/** What a feature needs: its recommended models (and their dependencies), or explicit ids. */
export type Requirement = { feature: string } | { models: string[] };

export type RequirementPhase =
  /** Everything is installed. */
  | 'ready'
  /** Something is missing and can be downloaded. */
  | 'idle'
  /** Downloading, verifying or installing (or waiting in the queue). */
  | 'working'
  | 'paused'
  | 'failed'
  /** Something is missing and cannot be downloaded yet (not published). */
  | 'unavailable';

export interface RequirementProgress {
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  /** 0..100, or null while nothing is known. */
  percent: number | null;
}

export interface ModelRequirement {
  ready: boolean;
  phase: RequirementPhase;
  /** Every model the feature needs, installed or not. */
  required: ModelInfo[];
  missing: ModelInfo[];
  /** Total size of the missing models. */
  missingBytes: number;
  progress: RequirementProgress | null;
  /** First failure, if any. */
  failure: { code: string; message: string } | null;
  /** The sub-state of the model being worked on ('verifying', 'installing', ...). */
  workingKind: 'queued' | 'downloading' | 'verifying' | 'installing' | null;
  install: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Live status of the models a feature needs, plus the actions to get them. Feature panels use it
 * to show the install banner and to disable their controls until `ready`.
 */
export function useModelRequirement(req: Requirement): ModelRequirement {
  const models = useHubStore((s) => s.models);
  const progressById = useHubStore((s) => s.progress);
  const loaded = useHubStore((s) => s.loaded);
  const key = 'feature' in req ? `f:${req.feature}` : `m:${req.models.join(',')}`;

  return useMemo(() => {
    const required: ModelInfo[] =
      'feature' in req
        ? requiredFor(models, req.feature)
        : req.models.map((id) => models[id]).filter((m): m is ModelInfo => !!m);
    const missing = required.filter((m) => !isUsable(m));
    const missingBytes = missing.reduce((n, m) => n + m.sizeBytes, 0);
    // Until the list has loaded we cannot claim anything is missing.
    const ready = !loaded || missing.length === 0;

    const failedModel = missing.find((m) => m.state.kind === 'failed');
    const failure =
      failedModel && failedModel.state.kind === 'failed'
        ? { code: failedModel.state.code, message: failedModel.state.message }
        : null;
    const working = missing.filter((m) => isActive(m.state.kind));
    const paused = missing.filter((m) => m.state.kind === 'paused');

    let phase: RequirementPhase;
    if (ready) phase = 'ready';
    else if (failure) phase = 'failed';
    else if (working.length > 0) phase = 'working';
    else if (paused.length > 0) phase = 'paused';
    else if (missing.some((m) => !m.installable)) phase = 'unavailable';
    else phase = 'idle';

    // Progress over everything required, so the bar never jumps back when one model finishes.
    let progress: RequirementProgress | null = null;
    if (!ready && (working.length > 0 || paused.length > 0)) {
      const totalBytes = required.reduce((n, m) => n + m.sizeBytes, 0);
      let downloaded = 0;
      let speed = 0;
      for (const m of required) {
        if (isUsable(m)) downloaded += m.sizeBytes;
        else downloaded += Math.min(progressById[m.id]?.downloadedBytes ?? 0, m.sizeBytes);
        if (m.state.kind === 'downloading') speed = progressById[m.id]?.speedBps ?? 0;
      }
      const remaining = Math.max(0, totalBytes - downloaded);
      progress = {
        downloadedBytes: downloaded,
        totalBytes,
        speedBps: speed,
        etaSeconds: speed > 0 ? Math.round(remaining / speed) : null,
        percent: totalBytes > 0 ? Math.min(100, Math.floor((downloaded / totalBytes) * 100)) : null,
      };
    }

    const kinds = working.map((m) => m.state.kind);
    const workingKind =
      (['installing', 'verifying', 'downloading', 'queued'] as const).find((k) =>
        kinds.includes(k),
      ) ?? null;

    const downloadable = missing.filter(
      (m) =>
        m.installable &&
        (m.state.kind === 'notInstalled' ||
          m.state.kind === 'failed' ||
          m.state.kind === 'paused' ||
          m.state.kind === 'updateAvailable'),
    );
    const each =
      (fn: (id: string) => Promise<void>, pick: (m: ModelInfo) => boolean) => async () => {
        for (const m of missing.filter(pick)) await fn(m.id);
      };
    return {
      ready,
      phase,
      required,
      missing,
      missingBytes,
      progress,
      failure,
      workingKind,
      install: () => installModels(downloadable.map((m) => m.id)),
      pause: each(pauseModel, (m) => isActive(m.state.kind)),
      resume: each(resumeModel, (m) => m.state.kind === 'paused'),
      cancel: each(
        cancelModel,
        (m) => isActive(m.state.kind) || m.state.kind === 'paused' || m.state.kind === 'failed',
      ),
    };
    // `req` is described fully by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, models, progressById, loaded]);
}
