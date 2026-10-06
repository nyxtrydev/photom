/**
 * Default shortcuts (Section 6.9). `mod` = Ctrl on Windows/Linux, Cmd on macOS.
 * Users can remap any action in Settings; overrides live in `settings.shortcuts`.
 */
export type ShortcutAction =
  | 'newProject'
  | 'openImages'
  | 'openProject'
  | 'saveProject'
  | 'saveProjectAs'
  | 'removeBackground'
  | 'exportPng'
  | 'copyClipboard'
  | 'undo'
  | 'redo'
  | 'toolMove'
  | 'toolKeep'
  | 'toolErase'
  | 'toolPan'
  | 'toolZoom'
  | 'brushSmaller'
  | 'brushLarger'
  | 'fit'
  | 'actualSize'
  | 'zoomIn'
  | 'zoomOut';

export type ShortcutMap = Record<ShortcutAction, string[]>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  newProject: ['mod+n'],
  openImages: ['mod+o'],
  openProject: ['mod+shift+o'],
  saveProject: ['mod+s'],
  saveProjectAs: ['mod+shift+s'],
  removeBackground: ['mod+r'],
  exportPng: ['mod+e'],
  copyClipboard: ['mod+shift+c'],
  undo: ['mod+z'],
  redo: ['mod+y', 'mod+shift+z'],
  toolMove: ['v'],
  toolKeep: ['b'],
  toolErase: ['e'],
  toolPan: ['h'],
  toolZoom: ['z'],
  brushSmaller: ['['],
  brushLarger: [']'],
  fit: ['mod+0'],
  actualSize: ['mod+1'],
  zoomIn: ['mod+=', 'mod++'],
  zoomOut: ['mod+-'],
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  newProject: 'New project',
  openImages: 'Open images',
  openProject: 'Open project',
  saveProject: 'Save',
  saveProjectAs: 'Save as',
  removeBackground: 'Remove background',
  exportPng: 'Export PNG',
  copyClipboard: 'Copy to clipboard',
  undo: 'Undo',
  redo: 'Redo',
  toolMove: 'Move tool',
  toolKeep: 'Keep brush',
  toolErase: 'Erase brush',
  toolPan: 'Pan tool',
  toolZoom: 'Zoom tool',
  brushSmaller: 'Smaller brush',
  brushLarger: 'Larger brush',
  fit: 'Fit to screen',
  actualSize: 'Actual size (100%)',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
};

export const SHORTCUT_ACTIONS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];

/** Defaults with the user's saved overrides applied. Unknown actions are ignored. */
export function effectiveShortcuts(overrides: Record<string, string[]>): ShortcutMap {
  const map = { ...DEFAULT_SHORTCUTS };
  for (const action of SHORTCUT_ACTIONS) {
    const o = overrides[action];
    if (Array.isArray(o) && o.length > 0) map[action] = o;
  }
  return map;
}

/** Overrides to persist: only the actions that differ from the defaults. */
export function overridesFrom(map: ShortcutMap): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const action of SHORTCUT_ACTIONS) {
    if (map[action].join('|') !== DEFAULT_SHORTCUTS[action].join('|')) out[action] = map[action];
  }
  return out;
}

/** Another action that already uses `combo`, or null. */
export function findConflict(
  map: ShortcutMap,
  action: ShortcutAction,
  combo: string,
): ShortcutAction | null {
  for (const other of SHORTCUT_ACTIONS) {
    if (other !== action && map[other].includes(combo)) return other;
  }
  return null;
}

/** Normalise a keyboard event to a combo string like "mod+shift+z". Null for bare modifiers. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && !/^[[\]=+-]$/.test(e.key)) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

export function actionFor(
  combo: string | null,
  map: ShortcutMap = DEFAULT_SHORTCUTS,
): ShortcutAction | null {
  if (!combo) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if (map[action].includes(combo)) return action;
  }
  return null;
}

/** Human-readable combo, e.g. "mod+shift+z" -> "Ctrl+Shift+Z" (or "⌘⇧Z" on macOS). */
export function formatCombo(
  combo: string,
  mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? ''),
) {
  const parts = combo.split(/\+(?!$)/);
  const key = parts.pop() ?? '';
  const names = parts.map((p) =>
    p === 'mod'
      ? mac
        ? '⌘'
        : 'Ctrl'
      : p === 'shift'
        ? mac
          ? '⇧'
          : 'Shift'
        : p === 'alt'
          ? mac
            ? '⌥'
            : 'Alt'
          : p,
  );
  const k = key.length === 1 ? key.toUpperCase() : key;
  return mac ? `${names.join('')}${k}` : [...names, k].join('+');
}
