import { ImagePlus } from 'lucide-react';
import { pickImages } from '@/api/dialogs';
import { importPaths } from '@/app/actions';
import { EditorCanvas } from '@/canvas/EditorCanvas';
import { EditorStatusBar } from '@/components/editor/EditorStatusBar';
import { Filmstrip } from '@/components/editor/Filmstrip';
import { UpscaleReview } from '@/components/editor/UpscaleReview';
import { UpscaleProgress } from '@/components/editor/UpscaleProgress';
import { useUpscaleStore } from '@/stores/upscaleStore';
import { PropertiesPanel } from '@/components/editor/PropertiesPanel';
import { ToolRail } from '@/components/editor/ToolRail';
import { Toolbar } from '@/components/editor/Toolbar';
import { useFileDrop } from '@/hooks/useFileDrop';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';

export function Editor() {
  useFileDrop();
  const activeId = useEditorStore((s) => s.activeId);
  const image = useProjectStore((s) => s.images.find((i) => i.id === activeId));
  const run = useUpscaleStore((s) => (activeId ? s.runs[activeId] : undefined));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <ToolRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 p-4">
            <div className="h-full w-full overflow-hidden rounded-md border border-border">
              {image && run?.phase === 'review' ? (
                <UpscaleReview
                  key={`${image.id}:${run.pending.path}`}
                  imageId={image.id}
                  pending={run.pending}
                />
              ) : image ? (
                <div className="relative h-full w-full">
                  <EditorCanvas key={image.id} image={image} />
                  {run?.phase === 'running' && <UpscaleProgress imageId={image.id} />}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <ImagePlus size={40} className="text-fg-muted" aria-hidden />
                  <h1 className="font-display text-2xl font-medium">{strings.editor.emptyTitle}</h1>
                  <p className="text-fg-muted">{strings.editor.emptyBody}</p>
                  <button
                    type="button"
                    onClick={async () => importPaths(await pickImages(), { openEditor: true })}
                    className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-contrast hover:bg-primary-hover"
                  >
                    {strings.home.openImages}
                  </button>
                </div>
              )}
            </div>
          </div>
          <Filmstrip />
        </div>
        <PropertiesPanel />
      </div>
      <EditorStatusBar />
    </div>
  );
}
