import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/canvas/EditorCanvas', () => ({
  EditorCanvas: ({ image }: { image: { name: string } }) => (
    <div data-testid="canvas">{image.name}</div>
  ),
}));
vi.mock('@/api/image', () => ({
  importImages: vi.fn(),
  prepareBackgroundImage: vi.fn(),
  prepareWorkingSet: vi.fn(),
  revealInFolder: vi.fn(),
  loadCacheBitmap: vi.fn(),
}));
vi.mock('@/api/inference', () => ({
  removeBackground: vi.fn(),
  setActiveMask: vi.fn().mockResolvedValue(undefined),
  getModelStatus: vi.fn(),
  onModelStatus: vi.fn(),
}));

import { App } from '@/app/App';
import { openInEditor } from '@/app/editorActions';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';

const meta = (id: string, w = 400, h = 200) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: w,
  height: h,
  format: 'jpeg',
  thumbnailPath: `/t/${id}.png`,
});

beforeEach(() => {
  useUiStore.setState({ screen: 'home', notices: [], settingsOpen: false });
  useEditorStore.setState({ states: {}, activeId: null, tool: 'move' });
  useProjectStore.getState().clearImages();
});

function openEditor(...ids: string[]) {
  useProjectStore.getState().addImages(ids.map((i) => meta(i)));
  openInEditor(ids[0]!);
}

describe('Editor screen', () => {
  it('is a full-screen workspace without the sidebar', () => {
    openEditor('a');
    render(<App />);
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas')).toHaveTextContent('a.jpg');
    expect(screen.getByRole('navigation', { name: 'Menu' })).toBeInTheDocument();
  });

  it('shows an empty state when no image is open', async () => {
    useUiStore.setState({ screen: 'edit' });
    render(<App />);
    expect(screen.getByText('No images open')).toBeInTheDocument();
  });

  it('switches tools from the tool rail and marks the active one', async () => {
    openEditor('a');
    render(<App />);
    const rail = screen.getByRole('toolbar', { name: 'Tools' });
    await userEvent.click(within(rail).getByRole('button', { name: /Erase/ }));
    expect(useEditorStore.getState().tool).toBe('erase');
    expect(within(rail).getByRole('button', { name: /Erase/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(rail).getByRole('button', { name: /Move/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it("switches between images in the filmstrip and keeps each image's state", async () => {
    openEditor('a', 'b');
    render(<App />);
    useEditorStore.getState().setRefine('a', { threshold: 80 });
    useEditorStore.getState().commitRefine('a');
    await userEvent.click(screen.getByRole('button', { name: 'b.jpg' }));
    expect(screen.getByTestId('canvas')).toHaveTextContent('b.jpg');
    expect(useEditorStore.getState().states['b']!.refine.threshold).toBe(50);
    await userEvent.click(screen.getByRole('button', { name: 'a.jpg' }));
    expect(useEditorStore.getState().states['a']!.refine.threshold).toBe(80);
  });

  it('enables Undo/Redo only when there is history, and they work', async () => {
    openEditor('a');
    render(<App />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();
    useEditorStore
      .getState()
      .addStroke('a', { mode: 'keep', size: 5, hardness: 50, points: [[1, 1, 1]] });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useEditorStore.getState().states['a']!.strokes).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled();
  });

  it('updates refine values from the numeric inputs (non-destructive state)', async () => {
    openEditor('a');
    render(<App />);
    const input = screen.getByRole('textbox', { name: 'Threshold value' });
    await userEvent.clear(input);
    await userEvent.type(input, '70');
    await userEvent.tab();
    expect(useEditorStore.getState().states['a']!.refine.threshold).toBe(70);
    expect(useEditorStore.getState().states['a']!.undo).toHaveLength(1);
  });

  it('clamps out-of-range numeric input', async () => {
    openEditor('a');
    render(<App />);
    const input = screen.getByRole('textbox', { name: 'Feather value' });
    await userEvent.clear(input);
    await userEvent.type(input, '999');
    await userEvent.tab();
    expect(useEditorStore.getState().states['a']!.refine.feather).toBe(20);
  });

  it('keeps aspect ratio when the lock is on', async () => {
    openEditor('a'); // 400 x 200
    render(<App />);
    const w = screen.getByRole('textbox', { name: 'Width' });
    await userEvent.clear(w);
    await userEvent.type(w, '100');
    await userEvent.tab();
    expect(useEditorStore.getState().states['a']!.output).toMatchObject({ width: 100, height: 50 });
  });

  it('changes the background kind and records it for undo', async () => {
    openEditor('a');
    render(<App />);
    await userEvent.click(screen.getByRole('radio', { name: 'Solid color' }));
    expect(useEditorStore.getState().states['a']!.background.kind).toBe('solid');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useEditorStore.getState().states['a']!.background.kind).toBe('transparent');
  });

  it('Back to Home returns to the sidebar layout', async () => {
    openEditor('a');
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'File' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Back to Home' }));
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('removes an image from the project via the filmstrip menu', async () => {
    openEditor('a', 'b');
    render(<App />);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.contextMenu(screen.getByRole('button', { name: 'a.jpg' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from project' }));
    expect(useProjectStore.getState().images.map((i) => i.id)).toEqual(['b']);
    expect(useEditorStore.getState().activeId).toBe('b');
  });
});
