import * as Slider from '@radix-ui/react-slider';
import { useState } from 'react';

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  disabled?: boolean;
}

/** Label + slider + numeric input, as in the Properties panel mockup. */
export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  disabled,
}: SliderRowProps) {
  // While typing, show the draft; otherwise always mirror the controlled value.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);

  const commitText = () => {
    const n = Number(text);
    setDraft(null);
    if (Number.isFinite(n)) {
      onChange(Math.min(max, Math.max(min, Math.round(n / step) * step)));
      onCommit?.();
    }
  };

  return (
    <div className="grid grid-cols-[76px_1fr_52px] items-center gap-3">
      <span className="text-sm text-fg">{label}</span>
      <Slider.Root
        className="relative flex h-5 w-full touch-none select-none items-center"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => v !== undefined && onChange(v)}
        onValueCommit={() => onCommit?.()}
        aria-label={label}
      >
        <Slider.Track className="relative h-1 grow rounded-full bg-border">
          <Slider.Range className="absolute h-full rounded-full bg-primary" />
        </Slider.Track>
        <Slider.Thumb
          aria-label={label}
          className="block h-4 w-4 rounded-full border-2 border-surface bg-primary shadow-card focus-visible:outline-2"
        />
      </Slider.Root>
      <input
        aria-label={`${label} value`}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), undefined)}
        className="w-full rounded-sm border border-border bg-muted px-2 py-1 text-center text-sm"
      />
    </div>
  );
}
