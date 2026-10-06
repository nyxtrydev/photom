import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, FolderOpen, Redo2, Save, Undo2, Upload, Wand2 } from 'lucide-react';
import { pickImages } from '@/api/dialogs';
import { importPaths, removeBackground } from '@/app/actions';
import { redoActive, undoActive } from '@/app/editorActions';
import { allPresets } from '@/app/exportOptions';
import { saveProject } from '@/app/projectActions';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { strings } from '@/i18n/strings';
import { useActiveState, useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';

const t = strings.editor.toolbar;
const btn =
  'inline-flex h-11 items-center gap-2.5 rounded-md border border-border bg-surface px-4 text-[15px] font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-surface';

const menuItem =
  'flex cursor-default items-center rounded-sm px-3 py-2 text-sm outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted';

export function Toolbar() {
  const id = useEditorStore((s) => s.activeId);
  const state = useActiveState();
  const compare = useEditorStore((s) => s.compare);
  const setCompare = useEditorStore((s) => s.setCompare);
  const busy = useProjectStore((s) => (id ? s.processing[id] === true : false));
  const imageCount = useProjectStore((s) => s.images.length);
  const custom = useSettingsStore((s) => s.exportPresets);
  const setExportDialog = useUiStore((s) => s.setExportDialog);
  const presets = allPresets(custom);

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3">
      <button type="button" className={btn} onClick={async () => importPaths(await pickImages())}>
        <FolderOpen size={20} aria-hidden />
        {t.open}
      </button>
      <button type="button" className={btn} disabled={!id} onClick={() => void saveProject()}>
        <Save size={20} aria-hidden />
        {t.save}
      </button>
      <button
        type="button"
        className={btn}
        disabled={!state || state.undo.length === 0}
        onClick={() => void undoActive()}
      >
        <Undo2 size={20} aria-hidden />
        {t.undo}
      </button>
      <button
        type="button"
        className={btn}
        disabled={!state || state.redo.length === 0}
        onClick={() => void redoActive()}
      >
        <Redo2 size={20} aria-hidden />
        {t.redo}
      </button>
      <span className="mx-1 h-8 w-px bg-border" aria-hidden />
      <button
        type="button"
        disabled={!id || busy}
        onClick={() => id && void removeBackground(id)}
        className="inline-flex h-11 items-center gap-2.5 rounded-md bg-primary px-6 text-[15px] font-semibold text-primary-contrast transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Wand2 size={20} aria-hidden />
        {busy ? t.processing : t.removeBg}
      </button>
      <div className="inline-flex">
        <button
          type="button"
          className={`${btn} rounded-r-none`}
          disabled={!id}
          onClick={() => setExportDialog({})}
        >
          <Upload size={20} aria-hidden />
          {t.exportPng}
        </button>
        <Menu.Root modal={false}>
          <Menu.Trigger
            aria-label={t.exportMore}
            disabled={!id}
            className={`${btn} rounded-l-none border-l-0 px-3`}
          >
            <ChevronDown size={18} aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-[220px] rounded-md border border-border bg-surface p-1 shadow-card"
            >
              <Menu.Label className="px-3 py-1 text-xs text-fg-muted">{t.presets}</Menu.Label>
              {presets.map((p) => (
                <Menu.Item
                  key={p.id}
                  className={menuItem}
                  onSelect={() => setExportDialog({ presetId: p.id })}
                >
                  {p.name}
                </Menu.Item>
              ))}
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item
                className={menuItem}
                disabled={imageCount < 2}
                onSelect={() => setExportDialog({ scope: 'all' })}
              >
                {t.exportAll}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>

      <div
        role="radiogroup"
        aria-label="View"
        className="ml-auto inline-flex rounded-md bg-muted p-1"
      >
        {(
          [
            ['split', strings.editor.compare.split],
            ['after', strings.editor.compare.after],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={compare === mode}
            onClick={() => setCompare(mode)}
            className={`rounded-sm px-3 py-1.5 text-sm font-medium ${compare === mode ? 'bg-primary text-primary-contrast' : 'hover:bg-surface'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
