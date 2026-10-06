import { ImagePlus, Loader2, Sparkles, Upload } from 'lucide-react';
import { useEffect } from 'react';
import { pickImages } from '@/api/dialogs';
import { importPaths, removeBackground } from '@/app/actions';
import { openInEditor, selectImage } from '@/app/editorActions';
import { EditorCanvas } from '@/canvas/EditorCanvas';
import { useFileDrop } from '@/hooks/useFileDrop';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';

const t = strings.quick;

/**
 * Quick single-image flow: choose or drop an image, the cut-out runs automatically, compare
 * Before/After, export. (The full editor is one click away.)
 */
export function RemoveBackground() {
  const hovering = useFileDrop(false);
  const activeId = useEditorStore((s) => s.activeId);
  const image = useProjectStore((s) => s.images.find((i) => i.id === activeId));
  const hasMask = useProjectStore((s) => (activeId ? !!s.masks[activeId] : false));
  const busy = useProjectStore((s) => (activeId ? s.processing[activeId] === true : false));
  const setExportDialog = useUiStore((s) => s.setExportDialog);

  // Automatically cut out whatever image is shown, once.
  useEffect(() => {
    if (image && !hasMask && !busy) void removeBackground(image.id);
    // Only when the image changes: a failed run must not retry in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.id]);

  const choose = async () => {
    const [first] = await importPaths(await pickImages());
    if (first) selectImage(first.id);
  };

  if (!image) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto p-8">
        <h1 className="font-display text-3xl font-medium">{t.title}</h1>
        <p className="mt-1 text-fg-muted">{t.subtitle}</p>
        <div
          className={`mt-6 flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
            hovering ? 'border-primary bg-muted' : 'border-border bg-surface/80'
          }`}
        >
          <ImagePlus size={44} strokeWidth={1.5} className="text-primary" aria-hidden />
          <button
            type="button"
            onClick={() => void choose()}
            className="inline-flex items-center gap-3 rounded-md bg-primary px-6 py-3 font-medium text-primary-contrast shadow-card hover:bg-primary-hover"
          >
            <Upload size={20} aria-hidden />
            {t.choose}
          </button>
          <p className="text-sm text-fg-muted">{t.dropHint}</p>
          <p className="text-sm text-fg-muted">{strings.home.formats}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-medium">{t.title}</h1>
          <p role="status" className="mt-1 flex items-center gap-2 text-sm text-fg-muted">
            {busy ? (
              <>
                <Loader2 size={15} className="animate-spin text-primary" aria-hidden />
                {t.working}
              </>
            ) : hasMask ? (
              <>
                <Sparkles size={15} className="text-primary" aria-hidden />
                {t.done}
              </>
            ) : (
              image.name
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void choose()}
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-muted"
          >
            {t.another}
          </button>
          <button
            type="button"
            onClick={() => openInEditor(image.id)}
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-muted"
          >
            {t.edit}
          </button>
          <button
            type="button"
            disabled={!hasMask}
            onClick={() => setExportDialog({ scope: 'current' })}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
          >
            <Upload size={18} aria-hidden />
            {t.exportPng}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
        <EditorCanvas key={image.id} image={image} />
      </div>
    </div>
  );
}
