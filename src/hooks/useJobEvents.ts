import { useEffect } from 'react';
import { onJobError, onJobItemComplete, onJobProgress } from '@/api/export';
import { isTauri } from '@/api/window';
import { handleItemComplete, refreshJob } from '@/app/exportActions';

/** Keeps job snapshots in sync with `job:*` events from the backend. */
export function useJobEvents() {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: (() => void)[] = [];
    let cancelled = false;
    const keep = (p: Promise<() => void>) =>
      void p.then((u) => (cancelled ? u() : unlisteners.push(u)));
    keep(onJobProgress((e) => void refreshJob(e.jobId)));
    keep(onJobError((e) => void refreshJob(e.jobId)));
    keep(onJobItemComplete(handleItemComplete));
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);
}
