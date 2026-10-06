import { useEffect, useState } from 'react';
import { updateSettings } from '@/app/settingsActions';
import {
  comboFromEvent,
  effectiveShortcuts,
  findConflict,
  formatCombo,
  overridesFrom,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  DEFAULT_SHORTCUTS,
  type ShortcutAction,
} from '@/app/shortcuts';
import { strings } from '@/i18n/strings';
import { useSettingsStore } from '@/stores/settingsStore';

const t = strings.settings.shortcuts;

export function ShortcutsPanel() {
  const overrides = useSettingsStore((s) => s.shortcuts);
  const map = effectiveShortcuts(overrides);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    document.body.dataset.captureKeys = 'true';
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        setError(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const conflict = findConflict(map, capturing, combo);
      if (conflict) {
        setError(t.conflict(SHORTCUT_LABELS[conflict]));
        return;
      }
      void updateSettings({ shortcuts: overridesFrom({ ...map, [capturing]: [combo] }) });
      setCapturing(null);
      setError(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      delete document.body.dataset.captureKeys;
    };
  }, [capturing, map]);

  const resetOne = (a: ShortcutAction) =>
    void updateSettings({ shortcuts: overridesFrom({ ...map, [a]: DEFAULT_SHORTCUTS[a] }) });

  return (
    <div>
      <p className="text-sm text-fg-muted">{t.hint}</p>
      <div role="status" aria-live="polite" className="min-h-6 text-sm text-danger">
        {error}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-fg-muted">
          <tr>
            <th className="pb-2 font-medium">{t.action}</th>
            <th className="pb-2 font-medium">{t.keys}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_ACTIONS.map((a) => {
            const isDefault = map[a].join('|') === DEFAULT_SHORTCUTS[a].join('|');
            return (
              <tr key={a} className="border-t border-border">
                <td className="py-2">{SHORTCUT_LABELS[a]}</td>
                <td className="py-2">
                  {capturing === a ? (
                    <span className="text-primary">{t.recording}</span>
                  ) : (
                    map[a].map((c) => (
                      <kbd
                        key={c}
                        className="mr-1 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs"
                      >
                        {formatCombo(c)}
                      </kbd>
                    ))
                  )}
                </td>
                <td className="whitespace-nowrap py-2 text-right">
                  <button
                    type="button"
                    aria-label={`${t.change} ${SHORTCUT_LABELS[a]}`}
                    onClick={() => {
                      setError(null);
                      setCapturing(a);
                    }}
                    className="rounded-sm px-2 py-1 hover:bg-muted"
                  >
                    {t.change}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t.reset} ${SHORTCUT_LABELS[a]}`}
                    disabled={isDefault}
                    onClick={() => resetOne(a)}
                    className="rounded-sm px-2 py-1 hover:bg-muted disabled:opacity-40"
                  >
                    {t.reset}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() => void updateSettings({ shortcuts: {} })}
        className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
      >
        {t.resetAll}
      </button>
    </div>
  );
}
