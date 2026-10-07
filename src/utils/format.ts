/** Decimal units, matching what operating systems show for downloads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) {
    const mb = bytes / 1_000_000;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export const formatSpeed = (bps: number) => `${formatBytes(bps)}/s`;

/** "about 16 s", "about 3 min", "about 2 h". */
export function formatEta(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
