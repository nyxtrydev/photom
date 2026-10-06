import * as ContextMenu from '@radix-ui/react-context-menu';
import { Plus } from 'lucide-react';
import { pickImages } from '@/api/dialogs';
import { revealInFolder } from '@/api/image';
import { importPaths, removeBackground } from '@/app/actions';
import { removeFromProject, selectImage } from '@/app/editorActions';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { assetUrl } from '@/utils/assetUrl';
import { reportError } from '@/app/errors';

const f = strings.editor.filmstrip;
const item = 'cursor-default rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted';

export function Filmstrip() {
  const images = useProjectStore((s) => s.images);
  const activeId = useEditorStore((s) => s.activeId);

  const reveal = async (id: string) => {
    try {
      await revealInFolder(id);
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <ul
      aria-label={f.label}
      className="flex h-[132px] shrink-0 items-center gap-4 overflow-x-auto border-t border-border bg-app px-4 py-3"
    >
      {images.map((img) => (
        <li key={img.id} className="shrink-0">
          <ContextMenu.Root modal={false}>
            <ContextMenu.Trigger asChild>
              <button
                type="button"
                aria-label={img.name}
                aria-current={activeId === img.id}
                onClick={() => selectImage(img.id)}
                className={`block h-[100px] w-[140px] overflow-hidden rounded-md bg-muted ${
                  activeId === img.id
                    ? 'outline outline-[3px] -outline-offset-1 outline-primary'
                    : 'border border-border'
                }`}
              >
                <img
                  src={assetUrl(img.thumbnailPath)}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover"
                />
              </button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="z-50 min-w-[220px] rounded-md border border-border bg-surface p-1 shadow-card">
                <ContextMenu.Item className={item} onSelect={() => removeFromProject(img.id)}>
                  {f.remove}
                </ContextMenu.Item>
                <ContextMenu.Item className={item} onSelect={() => void reveal(img.id)}>
                  {f.reveal}
                </ContextMenu.Item>
                <ContextMenu.Item className={item} onSelect={() => void removeBackground(img.id)}>
                  {f.rerun}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </li>
      ))}
      <li className="shrink-0">
        <button
          type="button"
          onClick={async () => importPaths(await pickImages())}
          className="flex h-[100px] w-[140px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-sm text-fg-muted hover:bg-muted"
        >
          <Plus size={22} aria-hidden />
          {f.add}
        </button>
      </li>
    </ul>
  );
}
