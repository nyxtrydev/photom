import { useEffect, useRef } from 'react';
import { autosaveProject, discardRecovery, listRecovery } from '@/api/project';
import { isTauri, windowApi } from '@/api/window';
import { onOpenFile, takeLaunchFile } from '@/api/system';
import { buildPayload, confirmDiscardChanges, openProject } from '@/app/projectActions';
import { loadSettings } from '@/app/settingsActions';
import { useEditorStore, type ImageEditState } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** Fields of an image state that make a project "modified" when they change. */
const persistedRefs = (s: ImageEditState) => [
  s.refine,
  s.background,
  s.output,
  s.strokes,
  s.maskRev,
];

/** Marks the project dirty when images or persisted editor state change. */
export function useDirtyTracking() {
  useEffect(() => {
    const snapshot = () => {
      const { images } = useProjectStore.getState();
      const { states } = useEditorStore.getState();
      return { ids: images.map((i) => i.id).join(','), refs: images.map((i) => states[i.id]) };
    };
    const loading = { current: false };
    let prev = snapshot();
    const check = () => {
      const next = snapshot();
      let changed = next.ids !== prev.ids;
      if (!changed) {
        next.refs.forEach((s, i) => {
          const a = prev.refs[i];
          if (s && a && s !== a) {
            const x = persistedRefs(a);
            const y = persistedRefs(s);
            if (x.some((v, k) => v !== y[k])) changed = true;
          }
        });
      }
      // Replacing a whole project (open/restore/new) loads fresh state objects: not a user edit.
      if (changed && !useProjectStore.getState().dirty && !loading.current) {
        useProjectStore.getState().setDirty(true);
      }
      prev = next;
    };
    const u1 = useEditorStore.subscribe(check);
    const u2 = useProjectStore.subscribe((s, p) => {
      if (s.projectId !== p.projectId) {
        // Project replaced: resync without marking dirty.
        loading.current = true;
        prev = snapshot();
        loading.current = false;
        return;
      }
      check();
    });
    return () => {
      u1();
      u2();
    };
  }, []);
}

const hhmm = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Background autosave while there are unsaved changes. Never blocks the UI. */
export function useAutosave() {
  const seconds = useSettingsStore((s) => s.autosaveSeconds);
  const busy = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    const id = setInterval(() => {
      const { dirty, images } = useProjectStore.getState();
      if (!dirty || images.length === 0 || busy.current) return;
      busy.current = true;
      autosaveProject(buildPayload())
        .then(() => useUiStore.getState().setLastAutosave(hhmm()))
        .catch(() => {
          /* autosave is best-effort; the next tick retries */
        })
        .finally(() => {
          busy.current = false;
        });
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [seconds]);
}

/** Intercept window close: ask about unsaved changes, and drop the autosave on a clean exit. */
export function useCloseGuard() {
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void windowApi
      .onCloseRequested(async (event) => {
        const { projectId } = useProjectStore.getState();
        event.preventDefault();
        if (await confirmDiscardChanges()) {
          await discardRecovery(projectId).catch(() => undefined);
          await windowApi.destroy();
        }
      })
      .then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

/** On startup: load settings and look for autosaves left behind by a crash. */
export function useStartup() {
  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      await loadSettings();
      // Launched by double-clicking a project: open it instead of offering recovery first.
      const launched = await takeLaunchFile().catch(() => null);
      if (launched) {
        await openProject(launched);
        return;
      }
      try {
        useUiStore.getState().setRecovery(await listRecovery());
      } catch {
        /* no recovery data */
      }
    })();
  }, []);
}

/** Open projects the OS hands to an already-running Photom (double-clicking another file). */
export function useOpenFileEvents() {
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onOpenFile((path) => void openProject(path)).then((u) =>
      cancelled ? u() : (unlisten = u),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
