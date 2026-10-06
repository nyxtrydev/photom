import { beforeEach, describe, expect, it } from 'vitest';
import type { Stroke } from '@/canvas/brush';
import type { MaskResult } from '@/types/dto';
import { useSettingsStore } from './settingsStore';
import { useEditorStore } from './editorStore';

const stroke = (n: number): Stroke => ({
  mode: 'keep',
  size: 10,
  hardness: 50,
  points: [[n, n, 1]],
});
const mask = (p: string): MaskResult => ({
  id: 'a',
  maskPath: p,
  width: 1,
  height: 1,
  boundingBox: null,
  durationMs: 1,
  device: 'cpu',
});
const st = () => useEditorStore.getState();
const img = () => st().states['a']!;

beforeEach(() => {
  useEditorStore.setState({ states: {}, activeId: null });
  useSettingsStore.setState({ undoDepth: 50 });
  st().ensureState('a', 400, 300);
});

describe('per-image state', () => {
  it('starts with defaults and the source size as output', () => {
    expect(img().refine).toEqual({ threshold: 50, feather: 2, edgeShift: 0 });
    expect(img().output).toMatchObject({ width: 400, height: 300, lockRatio: true });
  });
  it('keeps images independent', () => {
    st().ensureState('b', 10, 10);
    st().addStroke('a', stroke(1));
    expect(st().states['b']!.strokes).toHaveLength(0);
    st().ensureState('a', 1, 1); // must not reset an existing state
    expect(img().strokes).toHaveLength(1);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes strokes in order', () => {
    st().addStroke('a', stroke(1));
    st().addStroke('a', stroke(2));
    st().undo('a');
    expect(img().strokes).toEqual([stroke(1)]);
    st().undo('a');
    expect(img().strokes).toEqual([]);
    st().redo('a');
    st().redo('a');
    expect(img().strokes).toEqual([stroke(1), stroke(2)]);
  });

  it('a new edit clears the redo stack', () => {
    st().addStroke('a', stroke(1));
    st().undo('a');
    st().addStroke('a', stroke(2));
    expect(img().redo).toHaveLength(0);
  });

  it('records one refine step per slider drag and restores the start value', () => {
    st().setRefine('a', { threshold: 60 });
    st().setRefine('a', { threshold: 70 });
    st().setRefine('a', { threshold: 80 });
    st().commitRefine('a');
    expect(img().undo).toHaveLength(1);
    st().undo('a');
    expect(img().refine.threshold).toBe(50);
    st().redo('a');
    expect(img().refine.threshold).toBe(80);
  });

  it('ignores a slider drag that ends where it started', () => {
    st().setRefine('a', { feather: 9 });
    st().setRefine('a', { feather: 2 });
    st().commitRefine('a');
    expect(img().undo).toHaveLength(0);
  });

  it('covers background changes and merges rapid ones', () => {
    st().setBackground('a', { kind: 'solid' });
    st().setBackground('a', { color: '#112233' });
    st().setBackground('a', { color: '#445566' });
    expect(img().undo).toHaveLength(1);
    expect(img().background).toMatchObject({ kind: 'solid', color: '#445566' });
    st().undo('a');
    expect(img().background.kind).toBe('transparent');
  });

  it('clear edits is undoable and restores the strokes', () => {
    st().addStroke('a', stroke(1));
    st().clearEdits('a');
    expect(img().strokes).toHaveLength(0);
    st().undo('a');
    expect(img().strokes).toEqual([stroke(1)]);
  });

  it('reset refine is undoable', () => {
    st().setRefine('a', { threshold: 90 });
    st().commitRefine('a');
    st().resetRefine('a');
    expect(img().refine.threshold).toBe(50);
    st().undo('a');
    expect(img().refine.threshold).toBe(90);
  });

  it('re-runs bump maskRev both ways and hand the command back for side effects', () => {
    st().recordRerun('a', mask('/m/1.png'), mask('/m/2.png'));
    expect(img().maskRev).toBe(1);
    const cmd = st().undo('a');
    expect(cmd).toMatchObject({ type: 'rerun', before: { maskPath: '/m/1.png' } });
    expect(img().maskRev).toBe(2);
  });

  it('caps history at the configured depth', () => {
    useSettingsStore.setState({ undoDepth: 3 });
    for (let i = 0; i < 6; i++) st().addStroke('a', stroke(i));
    expect(img().undo).toHaveLength(3);
  });

  it('returns null when there is nothing to undo or redo', () => {
    expect(st().undo('a')).toBeNull();
    expect(st().redo('a')).toBeNull();
  });
});
