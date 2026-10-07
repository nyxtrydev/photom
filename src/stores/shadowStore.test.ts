import { beforeEach, describe, expect, it } from 'vitest';
import { defaultShadow, newDropLayer, type DropLayer } from '@/canvas/shadow';
import { useEditorStore, newImageState } from './editorStore';
import { fromPersisted, toPersisted } from './persist';

const ID = 'img';
const ed = () => useEditorStore.getState();
const cur = () => ed().states[ID]!;

describe('shadow editing', () => {
  beforeEach(() => {
    useEditorStore.setState({ states: { [ID]: newImageState(1000, 800) }, activeId: ID });
  });

  it('starts with no shadow and a frame equal to the image', () => {
    expect(cur().shadow).toBeNull();
    expect(cur().frame).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
  });

  it('enabling creates the defaults as one undo step', () => {
    ed().setShadow(ID, () => defaultShadow());
    expect(cur().shadow?.enabled).toBe(true);
    expect(cur().shadow?.layers).toHaveLength(1);
    expect(cur().undo).toHaveLength(1);
    ed().undo(ID);
    expect(cur().shadow).toBeNull();
    ed().redo(ID);
    expect(cur().shadow?.layers).toHaveLength(1);
  });

  it('a whole slider drag is a single undo step', () => {
    ed().setShadow(ID, () => defaultShadow());
    const before = cur().undo.length;
    const layerId = cur().shadow!.layers[0]!.id;
    const move = (distance: number) =>
      ed().setShadow(
        ID,
        (s) =>
          s && { ...s, layers: s.layers.map((l) => (l.id === layerId ? { ...l, distance } : l)) },
        true,
      );
    for (const d of [30, 60, 90, 120]) move(d);
    expect(cur().undo).toHaveLength(before); // nothing recorded while dragging
    expect((cur().shadow!.layers[0]! as DropLayer).distance).toBe(120);
    ed().commitShadow(ID);
    expect(cur().undo).toHaveLength(before + 1);

    ed().undo(ID);
    expect((cur().shadow!.layers[0]! as DropLayer).distance).toBe(24); // back to the value before the drag
    ed().redo(ID);
    expect((cur().shadow!.layers[0]! as DropLayer).distance).toBe(120);
  });

  it('a drag that ends where it began records nothing', () => {
    ed().setShadow(ID, () => defaultShadow());
    const steps = cur().undo.length;
    const before = cur().shadow;
    ed().setShadow(ID, (s) => s && { ...s, layers: [...s.layers] }, true);
    ed().setShadow(ID, () => before, true);
    ed().commitShadow(ID);
    expect(cur().undo).toHaveLength(steps);
  });

  it('adding, hiding and deleting layers are separate steps', () => {
    ed().setShadow(ID, () => defaultShadow());
    const base = cur().undo.length;
    ed().setShadow(ID, (s) => s && { ...s, layers: [...s.layers, newDropLayer()] });
    ed().setShadow(
      ID,
      (s) =>
        s && { ...s, layers: s.layers.map((l, i) => (i === 0 ? { ...l, visible: false } : l)) },
    );
    ed().setShadow(ID, (s) => s && { ...s, layers: s.layers.slice(1) });
    expect(cur().undo).toHaveLength(base + 3);
    expect(cur().shadow!.layers).toHaveLength(1);
    ed().undo(ID);
    expect(cur().shadow!.layers).toHaveLength(2);
    ed().undo(ID);
    expect(cur().shadow!.layers[0]!.visible).toBe(true);
    ed().undo(ID);
    expect(cur().shadow!.layers).toHaveLength(1);
  });

  it('a discrete edit closes a drag in progress first, keeping history in order', () => {
    ed().setShadow(ID, () => defaultShadow());
    ed().setShadow(
      ID,
      (s) => s && { ...s, layers: s.layers.map((l) => ({ ...l, blur: 80 })) },
      true,
    );
    ed().setShadow(ID, (s) => s && { ...s, autoExpand: false });
    expect(cur().pendingShadow).toBeNull();
    ed().undo(ID);
    expect(cur().shadow!.autoExpand).toBe(true);
    expect((cur().shadow!.layers[0]! as DropLayer).blur).toBe(80);
    ed().undo(ID);
    expect((cur().shadow!.layers[0]! as DropLayer).blur).toBe(32);
  });

  it('reset restores the defaults and can be undone', () => {
    ed().setShadow(ID, () => defaultShadow());
    ed().setShadow(
      ID,
      (s) => s && { ...s, layers: s.layers.map((l) => ({ ...l, distance: 300 })) },
    );
    ed().resetShadow(ID);
    expect((cur().shadow!.layers[0]! as DropLayer).distance).toBe(24);
    ed().undo(ID);
    expect((cur().shadow!.layers[0]! as DropLayer).distance).toBe(300);
  });

  it('undo clears a half-finished drag', () => {
    ed().setShadow(ID, () => defaultShadow());
    ed().setShadow(
      ID,
      (s) => s && { ...s, layers: s.layers.map((l) => ({ ...l, blur: 5 })) },
      true,
    );
    ed().undo(ID);
    expect(cur().pendingShadow).toBeNull();
  });

  it('setFrame only changes the state when the frame really changed', () => {
    const before = cur();
    ed().setFrame(ID, { x: 0, y: 0, w: 1000, h: 800 });
    expect(cur()).toBe(before);
    ed().setFrame(ID, { x: -5, y: 0, w: 1005, h: 800 });
    expect(cur().frame.x).toBe(-5);
  });

  it('survives save and load, and old projects without a shadow open as before', () => {
    ed().setShadow(ID, () => defaultShadow());
    const saved = JSON.parse(JSON.stringify(toPersisted(cur())));
    const back = fromPersisted(saved, 1000, 800);
    expect(back.shadow?.layers[0]).toMatchObject({ distance: 24, blur: 32, opacity: 0.45 });
    expect(back.frame).toEqual({ x: 0, y: 0, w: 1000, h: 800 });

    const { shadow: _drop, ...legacy } = saved;
    void _drop;
    expect(fromPersisted(legacy, 1000, 800).shadow).toBeNull();
  });
});
