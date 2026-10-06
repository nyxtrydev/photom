import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/settings', () => ({
  pathsExist: vi.fn(),
  removeRecentProject: vi.fn(),
  clearRecentProjects: vi.fn(),
  revealPath: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getAppInfo: vi.fn(),
  importModel: vi.fn(),
  openLogsFolder: vi.fn(),
}));
vi.mock('@/api/project', () => ({
  openProject: vi.fn(),
  projectBackupPath: vi.fn(),
  resetSession: vi.fn(),
  saveProject: vi.fn(),
  autosaveProject: vi.fn(),
  listRecovery: vi.fn(),
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn(),
}));
vi.mock('@/api/dialogs', () => ({
  pickProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickImages: vi.fn(),
  pickFolder: vi.fn(),
  pickBackgroundImage: vi.fn(),
}));

import { openProject as openProjectApi } from '@/api/project';
import { clearRecentProjects, pathsExist, removeRecentProject, revealPath } from '@/api/settings';
import { ConfirmDialog } from '@/dialogs/ConfirmDialog';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { RecentProjects } from './RecentProjects';

const recent = [
  { path: '/docs/dog.photom', name: 'dog', modified: '2026-10-05T10:24:00Z', thumbnail: null },
  { path: '/docs/gone.photom', name: 'gone', modified: '2026-10-04T10:24:00Z', thumbnail: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ notices: [], confirm: null });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, loaded: true, recentProjects: recent });
  vi.mocked(pathsExist).mockResolvedValue([true, false]);
});

describe('Recent projects', () => {
  it('shows the empty state and a disabled Clear button with no projects', () => {
    useSettingsStore.setState({ recentProjects: [] });
    render(<RecentProjects />);
    expect(screen.getByText(/No recent projects yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  it('marks projects whose file is missing as unavailable and offers only Remove', async () => {
    render(<RecentProjects />);
    expect(await screen.findByText('File not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open gone' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for gone' }));
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Reveal in folder' })).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Remove from list' })).not.toHaveAttribute(
      'data-disabled',
    );
  });

  it('removes a project from the list', async () => {
    vi.mocked(removeRecentProject).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      recentProjects: [recent[0]!],
    });
    render(<RecentProjects />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for gone' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove from list' }));
    expect(removeRecentProject).toHaveBeenCalledWith('/docs/gone.photom');
    await waitFor(() => expect(screen.queryByText('gone.photom')).not.toBeInTheDocument());
  });

  it('Reveal in folder calls the backend for an available project', async () => {
    render(<RecentProjects />);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for dog' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reveal in folder' }));
    expect(revealPath).toHaveBeenCalledWith('/docs/dog.photom');
  });

  it('opens an available project when its card is clicked', async () => {
    vi.mocked(openProjectApi).mockRejectedValue({ code: 'Io', message: 'x', details: null });
    render(<RecentProjects />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open dog' }));
    expect(openProjectApi).toHaveBeenCalledWith('/docs/dog.photom');
  });

  it('asks before clearing, and only clears on confirmation', async () => {
    vi.mocked(clearRecentProjects).mockResolvedValue({ ...DEFAULT_SETTINGS, recentProjects: [] });
    render(
      <>
        <RecentProjects />
        <ConfirmDialog />
      </>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(clearRecentProjects).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear list' }));
    expect(clearRecentProjects).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText(/No recent projects yet/)).toBeInTheDocument());
  });
});
