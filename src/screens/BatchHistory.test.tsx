import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/export', () => ({
  listHistory: vi.fn(),
  deleteHistoryItem: vi.fn(),
  clearHistory: vi.fn(),
  removeBackgroundBatch: vi.fn().mockResolvedValue('job-9'),
  getJob: vi.fn().mockResolvedValue({
    jobId: 'job-9',
    kind: 'removeBackground',
    status: 'running',
    done: 0,
    total: 0,
    items: [],
  }),
  exportPng: vi.fn(),
  cancelJob: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  copyToClipboard: vi.fn(),
  saveExportPreset: vi.fn(),
  deleteExportPreset: vi.fn(),
}));
vi.mock('@/api/settings', () => ({
  revealPath: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getAppInfo: vi.fn(),
  importModel: vi.fn(),
  openLogsFolder: vi.fn(),
  removeRecentProject: vi.fn(),
  clearRecentProjects: vi.fn(),
  pathsExist: vi.fn(),
}));
vi.mock('@/api/image', () => ({
  importImages: vi.fn().mockResolvedValue({ images: [], rejected: [] }),
  prepareWorkingSet: vi.fn(),
  prepareBackgroundImage: vi.fn(),
  revealInFolder: vi.fn(),
  loadCacheBitmap: vi.fn(),
}));
vi.mock('@/api/project', () => ({
  openProject: vi.fn().mockRejectedValue({ code: 'Io', message: 'x', details: null }),
  projectBackupPath: vi.fn(),
  resetSession: vi.fn(),
  saveProject: vi.fn(),
  autosaveProject: vi.fn(),
  listRecovery: vi.fn(),
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn(),
}));
vi.mock('@/api/dialogs', () => ({
  pickImages: vi.fn().mockResolvedValue([]),
  pickFolder: vi.fn(),
  pickProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickBackgroundImage: vi.fn(),
  pickExportFolder: vi.fn(),
  pickModelFile: vi.fn(),
}));

import { clearHistory, deleteHistoryItem, listHistory, removeBackgroundBatch } from '@/api/export';
import { importImages } from '@/api/image';
import { openProject as openProjectApi } from '@/api/project';
import { revealPath } from '@/api/settings';
import { ConfirmDialog } from '@/dialogs/ConfirmDialog';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { HistoryItem } from '@/types/export';
import { BatchProcess } from './BatchProcess';
import { History } from './History';

const meta = (id: string) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: 400,
  height: 300,
  format: 'jpeg',
  thumbnailPath: `/t/${id}.png`,
});
const mask = (id: string) => ({
  id,
  maskPath: `/m/${id}.png`,
  width: 400,
  height: 300,
  boundingBox: null,
  durationMs: 5,
  device: 'cpu' as const,
});

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    notices: [],
    screen: 'home',
    exportDialog: null,
    settingsOpen: false,
    confirm: null,
  });
  useQueueStore.setState({ jobs: {}, requests: {}, dialogJobId: null, reported: {} });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, loaded: true });
  useEditorStore.setState({ states: {}, activeId: null });
});

describe('Batch Process screen', () => {
  it('shows an empty state and disables actions with no images', () => {
    useProjectStore.getState().load({ name: 'p', path: null, images: [], masks: {}, dirty: false });
    render(<BatchProcess />);
    expect(screen.getByText(/No images yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove backgrounds' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export all...' })).toBeDisabled();
  });

  it('lists images with their cut-out status and counts', () => {
    useProjectStore.getState().load({
      name: 'p',
      path: null,
      images: [meta('a'), meta('b')],
      masks: { a: mask('a') },
      dirty: false,
    });
    render(<BatchProcess />);
    expect(screen.getByText('2 images · 1 with cut-out')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Images in this batch' })).getAllByRole(
      'listitem',
    );
    expect(within(rows[0]!).getByText('Cut-out ready')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Needs cut-out')).toBeInTheDocument();
    expect(screen.getByText('Model: fast · Processing: cpu')).toBeInTheDocument();
  });

  it('Remove backgrounds starts a batch job for the images that need it', async () => {
    useProjectStore.getState().load({
      name: 'p',
      path: null,
      images: [meta('a'), meta('b')],
      masks: { a: mask('a') },
      dirty: false,
    });
    render(<BatchProcess />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove backgrounds' }));
    expect(removeBackgroundBatch).toHaveBeenCalledWith(['b'], { model: 'fast', device: 'cpu' });
    expect(useQueueStore.getState().dialogJobId).toBe('job-9');
  });

  it('when everything is cut out the button offers a re-run of all', async () => {
    useProjectStore
      .getState()
      .load({ name: 'p', path: null, images: [meta('a')], masks: { a: mask('a') }, dirty: false });
    render(<BatchProcess />);
    await userEvent.click(screen.getByRole('button', { name: 'Re-run all' }));
    expect(removeBackgroundBatch).toHaveBeenCalledWith(['a'], expect.anything());
  });

  it('Export all opens the export dialog scoped to all images', async () => {
    useProjectStore
      .getState()
      .load({ name: 'p', path: null, images: [meta('a'), meta('b')], masks: {}, dirty: false });
    render(<BatchProcess />);
    await userEvent.click(screen.getByRole('button', { name: 'Export all...' }));
    expect(useUiStore.getState().exportDialog).toEqual({ scope: 'all' });
  });

  it('Edit opens the image in the editor; Remove drops it from the project', async () => {
    useProjectStore
      .getState()
      .load({ name: 'p', path: null, images: [meta('a'), meta('b')], masks: {}, dirty: false });
    useEditorStore.getState().ensureState('a', 400, 300);
    useEditorStore.getState().ensureState('b', 400, 300);
    render(<BatchProcess />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    expect(useEditorStore.getState().activeId).toBe('b');
    expect(useUiStore.getState().screen).toBe('edit');
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.jpg' }));
    expect(useProjectStore.getState().images.map((i) => i.id)).toEqual(['b']);
  });

  it('the settings shortcut opens Settings', async () => {
    render(<BatchProcess />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('adding images imports them without leaving the screen', async () => {
    const { pickImages } = await import('@/api/dialogs');
    vi.mocked(pickImages).mockResolvedValue(['/x/new.jpg']);
    render(<BatchProcess />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Images' }));
    expect(importImages).toHaveBeenCalledWith(['/x/new.jpg'], false);
    expect(useUiStore.getState().screen).toBe('home');
  });
});

const hist = (over: Partial<HistoryItem>): HistoryItem => ({
  id: 'h1',
  kind: 'export',
  name: 'dog.jpg',
  timestamp: '2026-10-05T10:24:00Z',
  sourcePath: '/photos/dog.jpg',
  outputPath: '/out/dog-photom.png',
  thumbnail: null,
  ...over,
});

describe('History screen', () => {
  it('shows an empty state', async () => {
    vi.mocked(listHistory).mockResolvedValue([]);
    render(<History />);
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  });

  it('lists exports and saved projects with type and time', async () => {
    vi.mocked(listHistory).mockResolvedValue([
      hist({}),
      hist({
        id: 'h2',
        kind: 'project',
        name: 'shop',
        outputPath: '/docs/shop.photom',
        sourcePath: null,
      }),
    ]);
    render(<History />);
    const list = await screen.findByRole('list', { name: 'History' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText(/^Export ·/)).toBeInTheDocument();
    expect(within(list).getByText(/^Project ·/)).toBeInTheDocument();
  });

  it('searches by name and path, and says when nothing matches', async () => {
    vi.mocked(listHistory).mockResolvedValue([
      hist({}),
      hist({
        id: 'h2',
        name: 'vase.jpg',
        outputPath: '/out/vase-photom.png',
        sourcePath: '/p/vase.jpg',
      }),
    ]);
    render(<History />);
    await screen.findByRole('list', { name: 'History' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search history' }), 'VASE');
    expect(
      within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search history' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search history' }), 'zzz');
    expect(screen.getByText('No history matches your search.')).toBeInTheDocument();
  });

  it('switches between grid and list view and remembers the choice', async () => {
    vi.mocked(listHistory).mockResolvedValue([hist({})]);
    localStorage.clear();
    render(<History />);
    await screen.findByRole('list', { name: 'History' });
    await userEvent.click(screen.getByRole('radio', { name: 'List view' }));
    expect(localStorage.getItem('photom.historyView')).toBe('list');
    expect(screen.getByRole('radio', { name: 'List view' })).toBeChecked();
  });

  it('Reveal in folder and Delete use the backend', async () => {
    vi.mocked(listHistory).mockResolvedValue([hist({})]);
    vi.mocked(deleteHistoryItem).mockResolvedValue([]);
    render(<History />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for dog.jpg' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reveal in folder' }));
    expect(revealPath).toHaveBeenCalledWith('/out/dog-photom.png');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for dog.jpg' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(deleteHistoryItem).toHaveBeenCalledWith('h1');
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
  });

  it('Open again re-imports the source of an export, and reopens a saved project', async () => {
    vi.mocked(listHistory).mockResolvedValue([
      hist({}),
      hist({
        id: 'h2',
        kind: 'project',
        name: 'shop',
        outputPath: '/docs/shop.photom',
        sourcePath: null,
      }),
    ]);
    render(<History />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open again: dog.jpg' }));
    expect(importImages).toHaveBeenCalledWith(['/photos/dog.jpg'], false);
    await userEvent.click(screen.getByRole('button', { name: 'Open again: shop' }));
    await waitFor(() => expect(openProjectApi).toHaveBeenCalledWith('/docs/shop.photom'));
  });

  it('Clear all asks first, and clears only on confirmation', async () => {
    vi.mocked(listHistory).mockResolvedValue([hist({})]);
    vi.mocked(clearHistory).mockResolvedValue([]);
    render(
      <>
        <History />
        <ConfirmDialog />
      </>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(clearHistory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    expect(clearHistory).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
  });
});
