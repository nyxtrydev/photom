import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@/app/App';
import '@/styles/index.css';

// Dev-only handle used by the Playwright end-to-end tests (e2e/).
if (import.meta.env.DEV) {
  void Promise.all([
    import('@/stores/editorStore'),
    import('@/stores/projectStore'),
    import('@/stores/settingsStore'),
    import('@/stores/uiStore'),
  ]).then(([editor, project, settings, ui]) => {
    (window as unknown as Record<string, unknown>).__photom = {
      editor: editor.useEditorStore,
      project: project.useProjectStore,
      settings: settings.useSettingsStore,
      ui: ui.useUiStore,
    };
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
