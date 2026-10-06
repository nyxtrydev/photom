import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/canvas/EditorCanvas', () => ({
  EditorCanvas: ({ image }: { image: { name: string } }) => (
    <div data-testid="canvas">{image.name}</div>
  ),
}));
vi.mock('@/api/image', () => ({
  importImages: vi.fn(),
  prepareWorkingSet: vi.fn(),
  prepareBackgroundImage: vi.fn(),
  revealInFolder: vi.fn(),
  loadCacheBitmap: vi.fn(),
}));
vi.mock('@/api/inference', () => ({
  removeBackground: vi.fn(),
  setActiveMask: vi.fn(),
  getModelStatus: vi.fn(),
  onModelStatus: vi.fn(),
}));
vi.mock('@/api/dialogs', () => ({
  pickImages: vi.fn(),
  pickFolder: vi.fn(),
  pickProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickBackgroundImage: vi.fn(),
  pickExportFolder: vi.fn(),
  pickModelFile: vi.fn(),
}));

import { pickImages } from '@/api/dialogs';
import { importImages } from '@/api/image';
import { removeBackground } from '@/api/inference';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';
import { RemoveBackground } from './RemoveBackground';

const meta = {
  id: 'a',
  path: '/x/dog.jpg',
  name: 'dog.jpg',
  width: 400,
  height: 300,
  format: 'jpeg',
  thumbnailPath: '',
};
const mask = {
  id: 'a',
  maskPath: '/m/a.png',
  width: 400,
  height: 300,
  boundingBox: null,
  durationMs: 800,
  device: 'cpu' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ notices: [], screen: 'removeBackground', exportDialog: null });
  useProjectStore.getState().load({ name: 'p', path: null, images: [], masks: {}, dirty: false });
  useEditorStore.setState({ states: {}, activeId: null });
  vi.mocked(pickImages).mockResolvedValue(['/x/dog.jpg']);
  vi.mocked(importImages).mockResolvedValue({ images: [meta], rejected: [] });
});

describe('Remove Background quick flow', () => {
  it('starts with a clear call to action', () => {
    render(<RemoveBackground />);
    expect(screen.getByRole('heading', { name: 'Remove Background' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose an image' })).toBeInTheDocument();
    expect(screen.getByText(/drop an image anywhere/)).toBeInTheDocument();
  });

  it('choosing an image imports it and cuts it out automatically, once', async () => {
    vi.mocked(removeBackground).mockResolvedValue(mask);
    render(<RemoveBackground />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose an image' }));
    expect(await screen.findByTestId('canvas')).toHaveTextContent('dog.jpg');
    await waitFor(() => expect(removeBackground).toHaveBeenCalledTimes(1));
    expect(vi.mocked(removeBackground).mock.calls[0]![0]).toBe('a');
    expect(await screen.findByText(/Done\. Drag the handle/)).toBeInTheDocument();
  });

  it('Export is disabled until the cut-out exists, then opens the export dialog', async () => {
    let finish!: (m: typeof mask) => void;
    vi.mocked(removeBackground).mockReturnValue(new Promise((r) => (finish = r)));
    render(<RemoveBackground />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose an image' }));
    expect(await screen.findByText('Cutting out the subject...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export PNG' })).toBeDisabled();
    finish(mask);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export PNG' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    expect(useUiStore.getState().exportDialog).toEqual({ scope: 'current' });
  });

  it('a failed cut-out is reported once and does not retry in a loop', async () => {
    vi.mocked(removeBackground).mockRejectedValue({
      code: 'ModelMissing',
      message: 'not found',
      details: null,
    });
    render(<RemoveBackground />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose an image' }));
    await waitFor(() => expect(useUiStore.getState().notices).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(removeBackground).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().notices[0]!.actions?.[0]?.label).toBe('Open model settings');
  });

  it('"Fine-tune in editor" opens the full editor on the same image', async () => {
    vi.mocked(removeBackground).mockResolvedValue(mask);
    render(<RemoveBackground />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose an image' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Fine-tune in editor' }));
    expect(useUiStore.getState().screen).toBe('edit');
    expect(useEditorStore.getState().activeId).toBe('a');
  });

  it('cancelling the file dialog changes nothing', async () => {
    vi.mocked(pickImages).mockResolvedValue([]);
    render(<RemoveBackground />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose an image' }));
    expect(importImages).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose an image' })).toBeInTheDocument();
  });
});
