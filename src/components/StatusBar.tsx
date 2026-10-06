import { strings } from '@/i18n/strings';
import { useModelStore } from '@/stores/modelStore';
import { useUiStore } from '@/stores/uiStore';

function describe(state: string | undefined) {
  switch (state) {
    case 'missing':
      return { text: strings.model.missing, dot: 'bg-danger', attention: true };
    case 'loading':
      return { text: strings.model.loading, dot: 'bg-primary animate-pulse', attention: false };
    case 'error':
      return { text: strings.model.error, dot: 'bg-danger', attention: true };
    case 'idle':
    case 'loaded':
      return { text: strings.model.ready, dot: 'bg-success', attention: false };
    default:
      return { text: strings.model.checking, dot: 'bg-fg-muted', attention: false };
  }
}

export function StatusBar() {
  const status = useModelStore((s) => s.status);
  const openSettings = useUiStore((s) => s.openSettings);
  const { text, dot, attention } = describe(status?.state);
  const loading = status?.state === 'loading';
  return (
    <footer
      role="status"
      aria-live="polite"
      className="flex h-11 shrink-0 items-center gap-3 border-t border-border px-6 text-sm"
    >
      <span className={`h-3 w-3 rounded-full ${dot}`} aria-hidden />
      {attention ? (
        <button
          type="button"
          title={status?.message ?? undefined}
          onClick={() => openSettings('model')}
          className="underline decoration-dotted underline-offset-4 hover:text-primary"
        >
          {text}
        </button>
      ) : (
        <span title={status?.message ?? undefined}>{text}</span>
      )}
      {loading && <span className="h-2.5 w-28 animate-pulse rounded-full bg-border" aria-hidden />}
    </footer>
  );
}
