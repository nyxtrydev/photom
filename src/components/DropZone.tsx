import { FolderOpen, ImageIcon, Plus } from 'lucide-react';
import { pickFolder, pickImages } from '@/api/dialogs';
import { importPaths } from '@/app/actions';
import { strings } from '@/i18n/strings';

interface DropZoneProps {
  hovering: boolean;
}

export function DropZone({ hovering }: DropZoneProps) {
  const openImages = async () => importPaths(await pickImages(), { openEditor: true });
  const openFolder = async () => {
    const dir = await pickFolder();
    if (dir) await importPaths([dir], { openEditor: true });
  };

  return (
    <div
      className={`flex h-full flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 text-center transition-colors ${
        hovering ? 'border-primary bg-muted' : 'border-border bg-surface/80'
      }`}
    >
      <div className="relative mb-4 flex h-24 w-28 items-center justify-center rounded-md bg-muted text-primary shadow-card">
        <ImageIcon size={44} strokeWidth={1.5} aria-hidden />
        <span className="absolute -bottom-2 -right-3 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-contrast shadow-card">
          <Plus size={20} aria-hidden />
        </span>
      </div>
      <h1 className="text-[28px] font-semibold leading-tight">
        {hovering ? strings.home.dropActive : strings.home.dropTitle}
      </h1>
      <p className="my-2 text-sm text-fg-muted">{strings.home.or}</p>
      <div className="flex gap-4">
        <button
          type="button"
          onClick={() => void openImages()}
          className="inline-flex items-center gap-3 rounded-md bg-primary px-6 py-3 font-medium text-primary-contrast shadow-card transition-colors hover:bg-primary-hover"
        >
          <FolderOpen size={20} aria-hidden />
          {strings.home.openImages}
        </button>
        <button
          type="button"
          onClick={() => void openFolder()}
          className="inline-flex items-center gap-3 rounded-md border border-border bg-muted px-6 py-3 font-medium transition-colors hover:bg-border"
        >
          <FolderOpen size={20} aria-hidden />
          {strings.home.openFolder}
        </button>
      </div>
      <p className="mt-5 text-sm text-fg-muted">{strings.home.formats}</p>
    </div>
  );
}
