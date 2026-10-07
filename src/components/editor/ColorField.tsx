import { useEditorStore } from '@/stores/editorStore';

const HEX = /^#[0-9a-fA-F]{6}$/;

interface Props {
  value: string;
  /** Called continuously while the colour changes (picker drag, typing a valid hex). */
  onChange: (hex: string) => void;
  /** Called once the user is done (blur / Enter / choosing a recent colour). */
  onCommit?: () => void;
  disabled?: boolean;
  pickLabel: string;
  hexLabel: string;
  recentLabel: string;
}

/** Swatch + hex field + recent colours, shared by the shadow layers. */
export function ColorField({
  value,
  onChange,
  onCommit,
  disabled,
  pickLabel,
  hexLabel,
  recentLabel,
}: Props) {
  const recent = useEditorStore((s) => s.recentColors);
  const addRecent = useEditorStore((s) => s.addRecentColor);
  const finish = (hex: string) => {
    addRecent(hex);
    onCommit?.();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label
          className="relative h-7 w-12 shrink-0 cursor-pointer overflow-hidden rounded-sm border border-border"
          style={{ background: value }}
        >
          <span className="sr-only">{pickLabel}</span>
          <input
            type="color"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onBlur={(e) => finish(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <input
          aria-label={hexLabel}
          defaultValue={value}
          key={value}
          maxLength={7}
          disabled={disabled}
          onBlur={(e) => {
            const v = (
              e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`
            ).toLowerCase();
            if (HEX.test(v)) {
              onChange(v);
              finish(v);
            } else e.target.value = value;
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="w-full rounded-sm border border-border bg-muted px-2 py-1 text-sm uppercase"
        />
      </div>
      {recent.length > 0 && (
        <div role="group" aria-label={recentLabel} className="flex gap-1.5">
          {recent.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              disabled={disabled}
              onClick={() => {
                onChange(c);
                onCommit?.();
              }}
              className="h-6 w-6 rounded-full border border-border"
              style={{ background: c }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
