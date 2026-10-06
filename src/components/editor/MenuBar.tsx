import * as Menu from '@radix-ui/react-dropdown-menu';
import { pickImages } from '@/api/dialogs';
import { importPaths, removeBackground } from '@/app/actions';
import { redoActive, undoActive } from '@/app/editorActions';
import { copyCurrentToClipboard } from '@/app/exportActions';
import { initialExportOptions } from '@/app/exportOptions';
import { newProject, openProject, saveProject, saveProjectAs } from '@/app/projectActions';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { actualSize, fitView, zoomStep } from '@/app/viewActions';
import { strings } from '@/i18n/strings';
import { useActiveState, useEditorStore } from '@/stores/editorStore';
import { useUiStore } from '@/stores/uiStore';

const m = strings.editor.menu;
const content = 'z-50 min-w-[230px] rounded-md border border-border bg-surface p-1 shadow-card';
const item =
  'flex cursor-default items-center justify-between gap-6 rounded-sm px-3 py-2 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted';

function Soon() {
  return <span className="text-xs text-fg-muted">{m.soon}</span>;
}

/** Editor menu bar. Items for later phases are present but disabled. */
export function MenuBar() {
  const state = useActiveState();
  const id = useEditorStore((s) => s.activeId);
  const toggleChecker = useEditorStore((s) => s.toggleChecker);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const setScreen = useUiStore((s) => s.setScreen);
  const setExportDialog = useUiStore((s) => s.setExportDialog);
  const imageCount = useProjectStore((s) => s.images.length);
  const ed = useEditorStore.getState;
  const recent = useSettingsStore((st) => st.recentProjects);

  const trigger = 'rounded-sm px-3 py-1.5 text-[15px] hover:bg-muted data-[state=open]:bg-muted';
  const hasImage = !!state;

  const menus: [string, React.ReactNode][] = [
    [
      m.file,
      <>
        <Menu.Item className={item} onSelect={() => void newProject()}>
          {m.newProject} <kbd className="text-xs text-fg-muted">Ctrl+N</kbd>
        </Menu.Item>
        <Menu.Item className={item} onSelect={() => void openProject()}>
          {m.openProject} <kbd className="text-xs text-fg-muted">Ctrl+Shift+O</kbd>
        </Menu.Item>
        <Menu.Item className={item} onSelect={async () => importPaths(await pickImages())}>
          {m.openImages} <kbd className="text-xs text-fg-muted">Ctrl+O</kbd>
        </Menu.Item>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item className={item} disabled={!hasImage} onSelect={() => void saveProject()}>
          {m.save} <kbd className="text-xs text-fg-muted">Ctrl+S</kbd>
        </Menu.Item>
        <Menu.Item className={item} disabled={!hasImage} onSelect={() => void saveProjectAs()}>
          {m.saveAs} <kbd className="text-xs text-fg-muted">Ctrl+Shift+S</kbd>
        </Menu.Item>
        <Menu.Sub>
          <Menu.SubTrigger className={item} disabled={recent.length === 0}>
            {m.recent} <span aria-hidden>›</span>
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent sideOffset={6} className={content}>
              {recent.map((r) => (
                <Menu.Item key={r.path} className={item} onSelect={() => void openProject(r.path)}>
                  {r.name}.photom
                </Menu.Item>
              ))}
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item className={item} onSelect={() => setScreen('home')}>
          {strings.editor.backToHome}
        </Menu.Item>
        <Menu.Item className={item} onSelect={() => void newProject()}>
          {m.closeProject}
        </Menu.Item>
      </>,
    ],
    [
      m.edit,
      <>
        <Menu.Item
          className={item}
          disabled={!state?.undo.length}
          onSelect={() => void undoActive()}
        >
          {m.undo} <kbd className="text-xs text-fg-muted">Ctrl+Z</kbd>
        </Menu.Item>
        <Menu.Item
          className={item}
          disabled={!state?.redo.length}
          onSelect={() => void redoActive()}
        >
          {m.redo} <kbd className="text-xs text-fg-muted">Ctrl+Y</kbd>
        </Menu.Item>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item
          className={item}
          disabled={!hasImage}
          onSelect={() => id && ed().resetRefine(id)}
        >
          {m.resetRefine}
        </Menu.Item>
        <Menu.Item
          className={item}
          disabled={!state?.strokes.length}
          onSelect={() => id && ed().clearEdits(id)}
        >
          {m.clearEdits}
        </Menu.Item>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item
          className={item}
          disabled={!hasImage}
          onSelect={() => id && void removeBackground(id)}
        >
          {strings.editor.toolbar.removeBg} <kbd className="text-xs text-fg-muted">Ctrl+R</kbd>
        </Menu.Item>
      </>,
    ],
    [
      m.view,
      <>
        <Menu.Item className={item} disabled={!hasImage} onSelect={() => zoomStep(1)}>
          {m.zoomIn} <kbd className="text-xs text-fg-muted">Ctrl++</kbd>
        </Menu.Item>
        <Menu.Item className={item} disabled={!hasImage} onSelect={() => zoomStep(-1)}>
          {m.zoomOut} <kbd className="text-xs text-fg-muted">Ctrl+-</kbd>
        </Menu.Item>
        <Menu.Item className={item} disabled={!hasImage} onSelect={fitView}>
          {m.fit} <kbd className="text-xs text-fg-muted">Ctrl+0</kbd>
        </Menu.Item>
        <Menu.Item className={item} disabled={!hasImage} onSelect={actualSize}>
          {m.actualSize} <kbd className="text-xs text-fg-muted">Ctrl+1</kbd>
        </Menu.Item>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Item className={item} onSelect={toggleChecker}>
          {m.toggleChecker}
        </Menu.Item>
        <Menu.Separator className="my-1 h-px bg-border" />
        <Menu.Label className="px-3 py-1 text-xs text-fg-muted">{m.theme}</Menu.Label>
        <Menu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
          {(['light', 'dark', 'system'] as const).map((t) => (
            <Menu.RadioItem key={t} value={t} className={item}>
              {strings.theme[t]}
              <Menu.ItemIndicator>●</Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </>,
    ],
    [
      m.export,
      <>
        <Menu.Item className={item} disabled={!hasImage} onSelect={() => setExportDialog({})}>
          {m.exportPng} <kbd className="text-xs text-fg-muted">Ctrl+E</kbd>
        </Menu.Item>
        <Menu.Item
          className={item}
          disabled={imageCount < 2}
          onSelect={() => setExportDialog({ scope: 'all' })}
        >
          {m.batchExport}
        </Menu.Item>
        <Menu.Item
          className={item}
          disabled={!hasImage}
          onSelect={() => void copyCurrentToClipboard(initialExportOptions())}
        >
          {m.copyClipboard} <kbd className="text-xs text-fg-muted">Ctrl+Shift+C</kbd>
        </Menu.Item>
      </>,
    ],
    [
      m.help,
      <>
        {[m.shortcuts, m.openLogs, m.about].map((label) => (
          <Menu.Item key={label} className={item} disabled>
            {label} <Soon />
          </Menu.Item>
        ))}
      </>,
    ],
  ];

  return (
    <nav aria-label="Menu" className="ml-6 flex items-center gap-1">
      {menus.map(([label, body]) => (
        <Menu.Root key={label} modal={false}>
          <Menu.Trigger className={trigger}>{label}</Menu.Trigger>
          <Menu.Portal>
            <Menu.Content align="start" sideOffset={6} className={content}>
              {body}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      ))}
    </nav>
  );
}
