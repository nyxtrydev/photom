import { useEffect } from 'react';
import { onCatalogUpdated, onModelError, onModelProgress, onModelState } from '@/api/models';
import { isTauri } from '@/api/window';
import { handleModelState, refreshModels } from '@/app/modelActions';
import { useHubStore } from '@/stores/hubStore';

/** Loads the model list and keeps it in sync with `model:*` events from the backend. */
export function useModelHub() {
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((u) => (cancelled ? u() : unlisteners.push(u)));
    keep(onModelState((e) => handleModelState(e.id, e.state)));
    keep(onModelProgress((p) => useHubStore.getState().setProgress(p)));
    keep(onCatalogUpdated(() => void refreshModels()));
    // Failures arrive as `failed` states; the error event adds nothing the UI does not show.
    keep(onModelError(() => undefined));
    void refreshModels();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);
}
