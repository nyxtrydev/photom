import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { onUpscaleProgress } from '@/api/upscale';
import { cancelUpscale } from '@/app/upscaleActions';
import { strings } from '@/i18n/strings';

const t = strings.upscale;

/** Covers the canvas while an upscale runs, with Cancel. */
export function UpscaleProgress({ imageId }: { imageId: string }) {
  const [tiles, setTiles] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void onUpscaleProgress(
      (p) => p.id === imageId && setTiles({ done: p.done, total: p.total }),
    ).then((u) => (gone ? u() : (off = u)));
    return () => {
      gone = true;
      off?.();
    };
  }, [imageId]);
  return (
    <div
      role="status"
      aria-label={t.progressLabel}
      className="absolute inset-0 z-10 flex items-center justify-center bg-app/60"
    >
      <span className="flex items-center gap-4 rounded-md bg-surface px-5 py-3 text-sm font-medium shadow-card">
        <Loader2 className="animate-spin text-primary" aria-hidden />
        {tiles ? t.tiles(tiles.done, tiles.total) : t.working}
        <button
          type="button"
          onClick={() => void cancelUpscale(imageId)}
          className="rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium hover:bg-border"
        >
          {t.cancel}
        </button>
      </span>
    </div>
  );
}
