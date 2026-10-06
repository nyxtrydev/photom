import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { strings } from '@/i18n/strings';
import { useUiStore, type Notice, type NoticeKind } from '@/stores/uiStore';

const tone: Record<NoticeKind, string> = {
  info: 'border-border',
  success: 'border-success',
  warning: 'border-primary',
  error: 'border-danger',
};

/** How long a toast stays (ms). Errors stay until dismissed so they are never missed. */
const LIFETIME: Record<NoticeKind, number | null> = {
  info: 6000,
  success: 6000,
  warning: 10000,
  error: null,
};

function NoticeItem({ notice }: { notice: Notice }) {
  const dismiss = useUiStore((s) => s.dismissNotice);
  const [paused, setPaused] = useState(false);
  const remaining = useRef<number | null>(LIFETIME[notice.kind]);
  const startedAt = useRef(0);

  // Auto-dismiss, but never while the pointer or keyboard focus is on the toast.
  useEffect(() => {
    if (remaining.current === null || paused) return;
    startedAt.current = Date.now();
    const id = setTimeout(() => dismiss(notice.id), remaining.current);
    return () => {
      clearTimeout(id);
      if (remaining.current !== null) {
        remaining.current = Math.max(1500, remaining.current - (Date.now() - startedAt.current));
      }
    };
  }, [paused, dismiss, notice.id]);

  const urgent = notice.kind === 'error' || notice.kind === 'warning';
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`flex items-start gap-3 rounded-md border bg-surface p-3 text-sm shadow-card ${tone[notice.kind]}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{notice.message}</p>
        {notice.details && (
          <details className="mt-1 text-fg-muted">
            <summary className="cursor-pointer text-xs underline">
              {strings.notices.showDetails}
            </summary>
            <p className="mt-1 whitespace-pre-line break-words">{notice.details}</p>
          </details>
        )}
        {notice.actions && notice.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {notice.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => {
                  a.onClick();
                  dismiss(notice.id);
                }}
                className="rounded-sm border border-border bg-muted px-2.5 py-1 text-xs font-medium hover:bg-border"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={strings.notices.dismiss}
        onClick={() => dismiss(notice.id)}
        className="rounded-sm p-1 text-fg-muted hover:bg-muted"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function NoticeStack() {
  const notices = useUiStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <section
      aria-label={strings.notices.region}
      data-notice-stack
      // Stays clickable while a modal dialog is open (Radix disables everything outside it).
      className="pointer-events-auto fixed bottom-14 right-5 z-[60] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2"
    >
      {notices.map((n) => (
        <NoticeItem key={n.id} notice={n} />
      ))}
    </section>
  );
}
