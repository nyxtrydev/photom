import { NoticeStack } from '@/components/NoticeStack';
import { MenuBar } from '@/components/editor/MenuBar';
import { Sidebar } from '@/components/Sidebar';
import { StatusBar } from '@/components/StatusBar';
import { TitleBar } from '@/components/TitleBar';
import { BatchProgressDialog } from '@/dialogs/BatchProgressDialog';
import { ConfirmDialog } from '@/dialogs/ConfirmDialog';
import { ExportDialog } from '@/dialogs/ExportDialog';
import { ModelsWelcomeDialog } from '@/dialogs/ModelsWelcomeDialog';
import { RecoveryDialog } from '@/dialogs/RecoveryDialog';
import { SettingsDialog } from '@/dialogs/SettingsDialog';
import {
  useAutosave,
  useCloseGuard,
  useDirtyTracking,
  useOpenFileEvents,
  useStartup,
} from '@/hooks/useProjectLifecycle';
import { projectTitle } from '@/app/projectActions';
import { useJobEvents } from '@/hooks/useJobEvents';
import { useModelHub } from '@/hooks/useModelHub';
import { useModelStatus } from '@/hooks/useModelStatus';
import { useShortcuts } from '@/hooks/useShortcuts';
import { useApplyTheme } from '@/hooks/useTheme';
import { BatchProcess } from '@/screens/BatchProcess';
import { History } from '@/screens/History';
import { RemoveBackground } from '@/screens/RemoveBackground';
import { Editor } from '@/screens/Editor';
import { Home } from '@/screens/Home';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';

function CurrentScreen() {
  const screen = useUiStore((s) => s.screen);
  switch (screen) {
    case 'home':
      return <Home />;
    case 'removeBackground':
      return <RemoveBackground />;
    case 'batch':
      return <BatchProcess />;
    case 'edit':
      return <Editor />;
    case 'history':
      return <History />;
  }
}

export function App() {
  useApplyTheme();
  useModelStatus();
  useModelHub();
  useShortcuts();
  useStartup();
  useOpenFileEvents();
  useJobEvents();
  useDirtyTracking();
  useAutosave();
  useCloseGuard();
  const screen = useUiStore((s) => s.screen);
  const project = useProjectStore((s) => s.name);
  const path = useProjectStore((s) => s.path);
  const dirty = useProjectStore((s) => s.dirty);
  const editing = screen === 'edit';

  return (
    <div className="flex h-full flex-col bg-app text-fg">
      <TitleBar centre={editing ? projectTitle(project, path, dirty) : undefined}>
        {editing && <MenuBar />}
      </TitleBar>
      <div className="flex min-h-0 flex-1">
        {/* The editor is a full-screen workspace: no sidebar. */}
        {!editing && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col">
          <CurrentScreen />
          {!editing && <StatusBar />}
        </main>
      </div>
      <SettingsDialog />
      <ConfirmDialog />
      <ExportDialog />
      <BatchProgressDialog />
      <RecoveryDialog />
      <ModelsWelcomeDialog />
      <NoticeStack />
    </div>
  );
}
