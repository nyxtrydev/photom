import { useState } from 'react';

interface NumberFieldProps {
  value: number | undefined;
  min?: number;
  max?: number;
  label: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
  className?: string;
}

/** Numeric input that lets you type freely and applies the value on blur or Enter. */
export function NumberField({
  value,
  min = 1,
  max = 100000,
  label,
  disabled,
  onCommit,
  className,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() !== '' && Number.isFinite(n)) {
      onCommit(Math.min(max, Math.max(min, Math.round(n))));
    }
  };

  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft ?? (value === undefined ? '' : String(value))}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(null);
      }}
      className={`w-full rounded-sm border border-border bg-muted px-2 py-1 text-sm ${className ?? ''}`}
    />
  );
}
