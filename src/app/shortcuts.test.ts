import { describe, expect, it } from 'vitest';
import {
  actionFor,
  comboFromEvent,
  DEFAULT_SHORTCUTS,
  effectiveShortcuts,
  findConflict,
  formatCombo,
  overridesFrom,
} from './shortcuts';

const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('shortcuts', () => {
  it('maps Ctrl and Cmd to mod', () => {
    expect(comboFromEvent(ev({ key: 'z', ctrlKey: true }))).toBe('mod+z');
    expect(comboFromEvent(ev({ key: 'z', metaKey: true }))).toBe('mod+z');
  });
  it('ignores bare modifier presses', () => {
    expect(comboFromEvent(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(comboFromEvent(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
  });
  it('distinguishes redo variants and the new project shortcuts', () => {
    expect(actionFor(comboFromEvent(ev({ key: 'Z', ctrlKey: true, shiftKey: true })))).toBe('redo');
    expect(actionFor(comboFromEvent(ev({ key: 'y', ctrlKey: true })))).toBe('redo');
    expect(actionFor(comboFromEvent(ev({ key: 's', ctrlKey: true })))).toBe('saveProject');
    expect(actionFor(comboFromEvent(ev({ key: 'S', ctrlKey: true, shiftKey: true })))).toBe(
      'saveProjectAs',
    );
    expect(actionFor(comboFromEvent(ev({ key: 'O', ctrlKey: true, shiftKey: true })))).toBe(
      'openProject',
    );
    expect(actionFor(comboFromEvent(ev({ key: 'n', metaKey: true })))).toBe('newProject');
  });
  it('resolves tool and brush keys', () => {
    expect(actionFor('b')).toBe('toolKeep');
    expect(actionFor(comboFromEvent(ev({ key: ']' })))).toBe('brushLarger');
  });
  it('has no duplicate combos across the defaults', () => {
    const all = Object.values(DEFAULT_SHORTCUTS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  describe('remapping', () => {
    it('applies overrides and ignores unknown actions', () => {
      const map = effectiveShortcuts({ undo: ['mod+u'], bogus: ['x'], redo: [] });
      expect(map.undo).toEqual(['mod+u']);
      expect(map.redo).toEqual(DEFAULT_SHORTCUTS.redo); // empty override falls back
      expect(actionFor('mod+u', map)).toBe('undo');
      expect(actionFor('mod+z', map)).toBeNull(); // old key is freed
    });
    it('only persists what differs from the defaults', () => {
      const map = effectiveShortcuts({ undo: ['mod+u'] });
      expect(overridesFrom(map)).toEqual({ undo: ['mod+u'] });
      expect(overridesFrom(DEFAULT_SHORTCUTS)).toEqual({});
    });
    it('detects conflicts with other actions but not with itself', () => {
      expect(findConflict(DEFAULT_SHORTCUTS, 'undo', 'mod+s')).toBe('saveProject');
      expect(findConflict(DEFAULT_SHORTCUTS, 'undo', 'mod+z')).toBeNull();
      expect(findConflict(DEFAULT_SHORTCUTS, 'undo', 'mod+q')).toBeNull();
    });
  });

  it('formats combos for both platforms', () => {
    expect(formatCombo('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatCombo('mod+shift+z', true)).toBe('⌘⇧Z');
    expect(formatCombo('[', false)).toBe('[');
    expect(formatCombo('mod++', false)).toBe('Ctrl++');
  });
});
