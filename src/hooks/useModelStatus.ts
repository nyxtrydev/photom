import { useEffect } from 'react';
import { getModelStatus, onModelStatus } from '@/api/inference';
import { isTauri } from '@/api/window';
import { useModelStore } from '@/stores/modelStore';

/** Loads the initial model status and keeps it in sync with `model:status` events. */
export function useModelStatus() {
  const setStatus = useModelStore((s) => s.setStatus);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getModelStatus().then((s) => !cancelled && setStatus(s));
    void onModelStatus(setStatus).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setStatus]);
}
