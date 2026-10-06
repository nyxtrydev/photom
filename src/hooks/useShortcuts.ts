import { useEffect } from 'react';
import { pickImages } from '@/api/dialogs';
import { importPaths, removeBackground } from '@/app/actions';
import { redoActive, undoActive } from '@/app/editorActions';
import { copyCurrentToClipboard } from '@/app/exportActions';
import { initialExportOptions } from '@/app/exportOptions';
import { newProject, openProject, saveProject, saveProjectAs } from '@/app/projectActions';
import {
  actionFor,
  comboFromEvent,
  effectiveShortcuts,
  type ShortcutAction,
} from '@/app/shortcuts';
import { actualSize, fitView, zoomStep } from '@/app/viewActions';
import { BRUSH_LIMITS } from '@/canvas/brush';
import { useEditorStore } from '@/stores/editorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  );
};

/** Actions that stay available while a text field has focus (they are Ctrl/Cmd combos). */
const WORKS_WHILE_TYPING = new Set<ShortcutAction>([
  'newProject',
  'openImages',
  'openProject',
  'saveProject',
  'saveProjectAs',
]);

/** Global keyboard shortcuts, honouring the user's remapping. Editor-only actions need the editor. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog is capturing keys (e.g. the shortcut recorder).
      if (document.body.dataset.captureKeys === 'true') return;
      const map = effectiveShortcuts(useSettingsStore.getState().shortcuts);
      const action = actionFor(comboFromEvent(e), map);
      if (!action) return;
      if (isTyping(e.target) && !WORKS_WHILE_TYPING.has(action)) return;
      if (e.repeat && action !== 'brushSmaller' && action !== 'brushLarger') return;

      const ui = useUiStore.getState();
      const ed = useEditorStore.getState();
      const inEditor = ui.screen === 'edit';
      const modalOpen = ui.confirm !== null || ui.settingsOpen || ui.exportDialog !== null;
      if (modalOpen) return;

      switch (action) {
        case 'newProject':
          e.preventDefault();
          void newProject();
          return;
        case 'openProject':
          e.preventDefault();
          void openProject();
          return;
        case 'saveProject':
          e.preventDefault();
          void saveProject();
          return;
        case 'saveProjectAs':
          e.preventDefault();
          void saveProjectAs();
          return;
        case 'openImages':
          e.preventDefault();
          void pickImages().then((p) => importPaths(p, { openEditor: !inEditor }));
          return;
      }
      if (!inEditor) return;
      e.preventDefault();
      switch (action) {
        case 'exportPng':
          if (ed.activeId) ui.setExportDialog({});
          break;
        case 'copyClipboard':
          if (ed.activeId) void copyCurrentToClipboard(initialExportOptions());
          break;
        case 'removeBackground':
          if (ed.activeId) void removeBackground(ed.activeId);
          break;
        case 'undo':
          void undoActive();
          break;
        case 'redo':
          void redoActive();
          break;
        case 'toolMove':
          ed.setTool('move');
          break;
        case 'toolKeep':
          ed.setTool('keep');
          break;
        case 'toolErase':
          ed.setTool('erase');
          break;
        case 'toolPan':
          ed.setTool('pan');
          break;
        case 'toolZoom':
          ed.setTool('zoom');
          break;
        case 'brushSmaller':
        case 'brushLarger': {
          const f = action === 'brushLarger' ? 1.15 : 1 / 1.15;
          const size = Math.round(ed.brush.size * f + (action === 'brushLarger' ? 1 : -1));
          ed.setBrush({
            size: Math.min(BRUSH_LIMITS.size.max, Math.max(BRUSH_LIMITS.size.min, size)),
          });
          break;
        }
        case 'fit':
          fitView();
          break;
        case 'actualSize':
          actualSize();
          break;
        case 'zoomIn':
          zoomStep(1);
          break;
        case 'zoomOut':
          zoomStep(-1);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
