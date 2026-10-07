import { Download, Loader2 } from 'lucide-react';
import { strings } from '@/i18n/strings';
import { isActive, useHubStore } from '@/stores/hubStore';
import { useUiStore } from '@/stores/uiStore';

const t = strings.models.chip;

/** Status-bar chip for a running download; opens the Models page. Renders nothing when idle. */
export function ModelDownloadChip() {
  const models = useHubStore((s) => s.models);
  const progress = useHubStore((s) => s.progress);
  const openSettings = useUiStore((s) => s.openSettings);

  const running = Object.values(models).filter(
    (m) => isActive(m.state.kind) || m.state.kind === 'paused',
  );
  const current = running.find((m) => m.state.kind === 'downloading') ?? running[0];
  if (!current) return null;

  const p = progress[current.id];
  const pct =
    p && p.totalBytes > 0
      ? Math.min(100, Math.floor((p.downloadedBytes / p.totalBytes) * 100))
      : null;
  const paused = current.state.kind === 'paused';
  const text = paused ? t.paused(current.name) : t.downloading(current.name, pct);
  const more = running.length - 1;

  return (
    <button
      type="button"
      onClick={() => openSettings('models')}
      title={t.open}
      className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-sm hover:bg-border"
    >
      {paused ? (
        <Download size={14} aria-hidden />
      ) : (
        <Loader2 size={14} className="animate-spin text-primary" aria-hidden />
      )}
      <span>{text}</span>
      {more > 0 && <span className="text-fg-muted">{t.more(more)}</span>}
    </button>
  );
}
