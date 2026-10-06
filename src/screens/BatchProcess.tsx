import { CheckCircle2, FolderOpen, ImagePlus, Settings2, Trash2, Wand2 } from 'lucide-react';
import { pickFolder, pickImages } from '@/api/dialogs';
import { importPaths } from '@/app/actions';
import { openInEditor, removeFromProject } from '@/app/editorActions';
import { startBatchRemoval } from '@/app/exportActions';
import { useFileDrop } from '@/hooks/useFileDrop';
import { strings } from '@/i18n/strings';
import { useProjectStore } from '@/stores/projectStore';
import { isFinished, useQueueStore } from '@/stores/queueStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { assetUrl } from '@/utils/assetUrl';

const t = strings.batchScreen;
const btn =
  'inline-flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50';

/** Queue management: add many images, remove all backgrounds with the same settings, export all. */
export function BatchProcess() {
  const hovering = useFileDrop();
  const images = useProjectStore((s) => s.images);
  const masks = useProjectStore((s) => s.masks);
  const processing = useProjectStore((s) => s.processing);
  const model = useSettingsStore((s) => s.modelType);
  const device = useSettingsStore((s) => s.processing);
  const running = useQueueStore((s) =>
    Object.values(s.jobs).some((j) => j.kind === 'removeBackground' && !isFinished(j)),
  );
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setExportDialog = useUiStore((s) => s.setExportDialog);

  const ready = images.filter((i) => masks[i.id]).length;
  const pending = images.length - ready;

  return (
    <div className={`flex-1 overflow-y-auto p-8 ${hovering ? 'bg-muted' : ''}`}>
      <h1 className="font-display text-3xl font-medium">{t.title}</h1>
      <p className="mt-1 text-fg-muted">{t.subtitle}</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className={btn} onClick={async () => importPaths(await pickImages())}>
          <ImagePlus size={18} aria-hidden />
          {t.add}
        </button>
        <button
          type="button"
          className={btn}
          onClick={async () => {
            const dir = await pickFolder();
            if (dir) await importPaths([dir]);
          }}
        >
          <FolderOpen size={18} aria-hidden />
          {t.addFolder}
        </button>
        <span className="mx-1 h-8 w-px bg-border" aria-hidden />
        <button
          type="button"
          disabled={images.length === 0 || running}
          onClick={() =>
            void startBatchRemoval(pending === 0 ? images.map((i) => i.id) : undefined)
          }
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-contrast hover:bg-primary-hover disabled:opacity-50"
        >
          <Wand2 size={18} aria-hidden />
          {pending === 0 && images.length > 0 ? t.rerunAll : t.removeAll}
        </button>
        <button
          type="button"
          disabled={images.length === 0}
          className={btn}
          onClick={() => setExportDialog({ scope: 'all' })}
        >
          {t.exportAll}
        </button>
      </div>

      <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
        <Settings2 size={16} aria-hidden />
        {t.settings(model, device)}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="font-medium text-primary underline"
        >
          {t.change}
        </button>
      </p>

      {images.length === 0 ? (
        <p className="mt-6 rounded-md border border-dashed border-border px-6 py-12 text-center text-sm text-fg-muted">
          {t.empty}
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm font-medium">{t.count(images.length, ready)}</p>
          <ul
            aria-label={t.listLabel}
            className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3"
          >
            {images.map((img) => {
              const has = !!masks[img.id];
              const busy = processing[img.id] === true;
              return (
                <li
                  key={img.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-surface p-3 shadow-card"
                >
                  <span className="checkerboard h-16 w-16 shrink-0 overflow-hidden rounded-sm">
                    <img
                      src={assetUrl(img.thumbnailPath)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={img.path}>
                      {img.name}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {img.width} × {img.height}
                    </p>
                    <p
                      className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium ${has ? 'text-success-fg' : 'text-fg-muted'}`}
                    >
                      {has && <CheckCircle2 size={13} aria-hidden />}
                      {busy ? t.working : has ? t.ready : t.needs}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => openInEditor(img.id)}
                      className="rounded-sm px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      {t.edit}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t.remove} ${img.name}`}
                      onClick={() => removeFromProject(img.id)}
                      className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-danger hover:bg-muted"
                    >
                      <Trash2 size={12} aria-hidden />
                      {t.remove}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
