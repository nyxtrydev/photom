import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/actions', () => ({ removeBackground: vi.fn() }));
vi.mock('@/app/exportActions', () => ({ applyShadowToAll: vi.fn() }));
vi.mock('@/api/shadow', () => ({
  listShadowPresets: vi.fn(),
  saveShadowPreset: vi.fn(async (p: { id: string; name: string }) => [
    { ...p, id: p.id || 'saved-1' },
  ]),
  deleteShadowPreset: vi.fn(async () => []),
}));

import { deleteShadowPreset, saveShadowPreset } from '@/api/shadow';
import { removeBackground } from '@/app/actions';
import { applyShadowToAll } from '@/app/exportActions';
import { useSettingsStore } from '@/stores/settingsStore';
import { defaultShadow, newDropLayer, type DropLayer } from '@/canvas/shadow';
import { newImageState, useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { ShadowPanel } from './ShadowPanel';

const ID = 'img';
const ed = () => useEditorStore.getState();
const shadow = () => ed().states[ID]!.shadow;
const mask = {
  id: ID,
  maskPath: '/m.png',
  width: 10,
  height: 10,
  boundingBox: null,
  durationMs: 1,
  device: 'cpu' as const,
};

function setup({ withMask = true, withShadow = false } = {}) {
  const state = newImageState(1000, 800);
  useEditorStore.setState({
    states: { [ID]: withShadow ? { ...state, shadow: defaultShadow() } : state },
    activeId: ID,
    recentColors: [],
    shadowOnly: false,
  });
  useSettingsStore.setState({ shadowPresets: [] });
  useProjectStore.setState({ masks: withMask ? { [ID]: mask } : {} });
  return render(<ShadowPanel />);
}

async function addLayer(name: string) {
  await userEvent.click(screen.getByRole('button', { name: /Add a shadow layer/ }));
  await userEvent.click(await screen.findByRole('menuitem', { name: new RegExp(name) }));
}

describe('ShadowPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for a cut-out first and offers a Remove BG shortcut', async () => {
    setup({ withMask: false });
    expect(screen.getByText(/Remove the background first/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Enable' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove BG' }));
    expect(removeBackground).toHaveBeenCalledWith(ID);
  });

  it('is off until enabled; enabling creates one default drop shadow', async () => {
    setup();
    expect(screen.getByRole('checkbox', { name: 'Enable' })).not.toBeChecked();
    expect(screen.queryByRole('group', { name: 'Drop shadow' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Enable' }));
    expect(shadow()?.enabled).toBe(true);
    const layer = screen.getByRole('group', { name: 'Drop shadow' });
    expect(within(layer).getByRole('textbox', { name: 'Angle value' })).toHaveValue('135');
    expect(within(layer).getByRole('textbox', { name: 'Distance value' })).toHaveValue('24');
    expect(within(layer).getByRole('textbox', { name: 'Opacity value' })).toHaveValue('45');
  });

  it('turning it off keeps the settings', async () => {
    setup({ withShadow: true });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Enable' }));
    expect(shadow()?.enabled).toBe(false);
    expect(shadow()?.layers).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Distance value' })).toBeDisabled();
  });

  it('typing a value updates the layer as one undo step, within limits', async () => {
    setup({ withShadow: true });
    const steps = ed().states[ID]!.undo.length;
    const field = screen.getByRole('textbox', { name: 'Distance value' });
    await userEvent.clear(field);
    await userEvent.type(field, '9999{Enter}');
    expect((shadow()!.layers[0]! as DropLayer).distance).toBe(500); // clamped
    expect(ed().states[ID]!.undo.length).toBe(steps + 1);
    ed().undo(ID);
    expect((shadow()!.layers[0]! as DropLayer).distance).toBe(24);
  });

  it('opacity is shown as a percentage and stored as a fraction', async () => {
    setup({ withShadow: true });
    const field = screen.getByRole('textbox', { name: 'Opacity value' });
    await userEvent.clear(field);
    await userEvent.type(field, '80{Enter}');
    expect(shadow()!.layers[0]!.opacity).toBeCloseTo(0.8);
  });

  it('hides, shows and deletes a layer', async () => {
    setup({ withShadow: true });
    const hide = screen.getByRole('button', { name: 'Hide Drop shadow' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(hide);
    expect(shadow()!.layers[0]!.visible).toBe(false);
    expect(screen.getByRole('button', { name: 'Show Drop shadow' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete Drop shadow' }));
    expect(shadow()!.layers).toHaveLength(0);
    expect(screen.getByText(/No layers yet/)).toBeVisible();
  });

  it('adds layers up to the limit', async () => {
    setup({ withShadow: true });
    const add = screen.getByRole('button', { name: /Add a shadow layer/ });
    for (let i = 0; i < 7; i++) await addLayer('Drop shadow');
    expect(shadow()!.layers).toHaveLength(8);
    expect(add).toBeDisabled();
    expect(screen.getAllByTestId('shadow-layer')).toHaveLength(8);
  });

  it('edits only the layer it belongs to', async () => {
    setup({ withShadow: true });
    await addLayer('Drop shadow');
    const [first, second] = screen.getAllByTestId('shadow-layer');
    const field = within(second!).getByRole('textbox', { name: 'Blur value' });
    await userEvent.clear(field);
    await userEvent.type(field, '100{Enter}');
    expect(shadow()!.layers.map((l) => (l as DropLayer).blur)).toEqual([32, 100]);
    expect(within(first!).getByRole('textbox', { name: 'Blur value' })).toHaveValue('32');
  });

  it('changing the colour by hex works and remembers it', async () => {
    setup({ withShadow: true });
    const hex = screen.getByRole('textbox', { name: 'Shadow colour hex' });
    await userEvent.clear(hex);
    await userEvent.type(hex, 'ff8800{Enter}');
    expect((shadow()!.layers[0]! as DropLayer).color).toBe('#ff8800');
    expect(ed().recentColors).toContain('#ff8800');
  });

  it('a bad hex is rejected and reverts', async () => {
    setup({ withShadow: true });
    const hex = screen.getByRole('textbox', { name: 'Shadow colour hex' });
    await userEvent.clear(hex);
    await userEvent.type(hex, 'nope{Enter}');
    expect((shadow()!.layers[0]! as DropLayer).color).toBe('#2b1a10');
    expect(hex).toHaveValue('#2b1a10');
  });

  it('Auto expand canvas can be switched off, and Reset restores the defaults', async () => {
    setup({ withShadow: true });
    await userEvent.click(screen.getByRole('checkbox', { name: /Auto expand canvas/ }));
    expect(shadow()!.autoExpand).toBe(false);
    ed().setShadow(ID, (s) => s && { ...s, layers: [...s.layers, newDropLayer({ distance: 90 })] });
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(shadow()!.autoExpand).toBe(true);
    expect(shadow()!.layers).toHaveLength(1);
  });

  it('a reflection layer has no colour (it uses the subject’s) and its own sliders', async () => {
    setup({ withShadow: true });
    await addLayer('Reflection');
    const card = screen.getByRole('group', { name: 'Reflection' });
    expect(within(card).queryByRole('textbox', { name: 'Shadow colour hex' })).toBeNull();
    for (const f of ['Gap', 'Fade length', 'Blur', 'Opacity']) {
      expect(within(card).getByRole('textbox', { name: `${f} value` })).toBeVisible();
    }
    expect(shadow()!.layers.map((l) => l.type)).toEqual(['drop', 'reflection']);
  });

  it('shows the four built-in presets; choosing one replaces the layers in one undo step', async () => {
    setup({ withShadow: true });
    const group = screen.getByRole('group', { name: 'Preset' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Product', 'Floating', 'Grounded', 'Soft studio', 'Custom']);
    await userEvent.click(within(group).getByRole('button', { name: 'Grounded' }));
    expect(shadow()!.presetId).toBe('grounded');
    expect(shadow()!.layers.map((l) => l.type)).toEqual(['contact', 'cast']);
    expect(within(group).getByRole('button', { name: 'Grounded' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    ed().undo(ID);
    expect(shadow()!.layers.map((l) => l.type)).toEqual(['drop']);
  });

  it('presets scale to the image and editing a layer switches back to Custom', async () => {
    setup({ withShadow: true }); // a 1000 x 800 image: 2/3 of the 1500 px reference
    await userEvent.click(screen.getByRole('button', { name: 'Product' }));
    expect((shadow()!.layers[0] as DropLayer).distance).toBeCloseTo(14 * (1000 / 1500), 5);
    const card = screen.getAllByTestId('shadow-layer')[0]!;
    const field = within(card).getByRole('textbox', { name: 'Distance value' });
    await userEvent.clear(field);
    await userEvent.type(field, '50{Enter}');
    expect(shadow()!.presetId).toBeNull();
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('saves the current shadow as a named preset, then renames and deletes it', async () => {
    setup({ withShadow: true });
    await userEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Preset name' }), 'Shoe shots{Enter}');
    expect(saveShadowPreset).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(saveShadowPreset).mock.calls[0]![0];
    expect(sent).toMatchObject({ name: 'Shoe shots', refSide: 1500, autoExpand: true });
    expect(sent.layers[0]).toMatchObject({ type: 'drop' });
    expect(sent.layers[0]).not.toHaveProperty('id'); // layer ids never leave the editor

    // The settings now hold it, and it is selected.
    expect(useSettingsStore.getState().shadowPresets).toHaveLength(1);
    expect(shadow()!.presetId).toBe('saved-1');
    expect(screen.getByRole('button', { name: 'Shoe shots' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const box = screen.getByRole('textbox', { name: 'Preset name' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Boots{Enter}');
    expect(vi.mocked(saveShadowPreset).mock.calls[1]![0]).toMatchObject({
      id: 'saved-1',
      name: 'Boots',
    });

    await userEvent.click(screen.getByRole('button', { name: /Delete preset/ }));
    expect(deleteShadowPreset).toHaveBeenCalledWith('saved-1');
    expect(shadow()!.presetId).toBeNull();
  });

  it('built-in presets cannot be renamed or deleted', async () => {
    setup({ withShadow: true });
    await userEvent.click(screen.getByRole('button', { name: 'Floating' }));
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete preset/ })).toBeNull();
  });

  it('an empty preset name cannot be saved', async () => {
    setup({ withShadow: true });
    await userEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Preset name' })).toBeNull();
    expect(saveShadowPreset).not.toHaveBeenCalled();
  });

  it('Shadow only is a view setting: it is not saved and does not touch the undo history', async () => {
    setup({ withShadow: true });
    const box = screen.getByRole('checkbox', { name: /Shadow only/ });
    await userEvent.click(box);
    expect(ed().shadowOnly).toBe(true);
    expect(ed().states[ID]!.undo).toHaveLength(0);
    await userEvent.click(box);
    expect(ed().shadowOnly).toBe(false);
  });

  it('linear light is an undoable per-image option', async () => {
    setup({ withShadow: true });
    const box = screen.getByRole('checkbox', { name: /Blend layers in linear light/ });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(shadow()!.linearLight).toBe(true);
    ed().undo(ID);
    expect(shadow()!.linearLight).toBe(false);
  });

  it('Apply to all images needs another image and at least one layer, then starts the job', async () => {
    setup({ withShadow: true });
    const btn = screen.getByRole('button', { name: 'Apply to all images' });
    expect(btn).toBeDisabled(); // only one image
    useProjectStore.setState({
      images: [
        { id: ID, path: '/a', name: 'a', width: 10, height: 10, format: 'png', thumbnailPath: '' },
        { id: 'b', path: '/b', name: 'b', width: 10, height: 10, format: 'png', thumbnailPath: '' },
      ],
    });
    await vi.waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    expect(applyShadowToAll).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Drop shadow' }));
    expect(btn).toBeDisabled(); // nothing left to apply
  });
});
