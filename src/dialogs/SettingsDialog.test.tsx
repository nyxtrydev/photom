import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/settings', () => ({
  updateSettings: vi.fn(async (s: unknown) => s),
  getSettings: vi.fn(),
  readLicences: vi.fn().mockResolvedValue('MIT License\n\nCopyright (c) Example'),
  getAppInfo: vi.fn().mockResolvedValue({
    version: '0.1.0',
    logsDir: '/logs',
    models: [
      {
        kind: 'fast',
        fileName: 'isnet-general-use.onnx',
        licence: 'Apache-2.0',
        present: true,
        path: '/m/isnet.onnx',
      },
    ],
  }),
  importModel: vi.fn(),
  openLogsFolder: vi.fn(),
  removeRecentProject: vi.fn(),
  clearRecentProjects: vi.fn(),
  pathsExist: vi.fn(),
  revealPath: vi.fn(),
}));
vi.mock('@/api/updates', () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
  onUpdateProgress: vi.fn(),
}));
vi.mock('@/api/inference', () => ({
  getModelStatus: vi.fn().mockResolvedValue({
    ready: true,
    state: 'idle',
    activeModel: 'fast',
    device: 'cpu',
    path: '/m',
    message: null,
  }),
  removeBackground: vi.fn(),
  setActiveMask: vi.fn(),
  onModelStatus: vi.fn(),
}));
vi.mock('@/api/dialogs', () => ({
  pickExportFolder: vi.fn().mockResolvedValue('/exports'),
  pickModelFile: vi.fn(),
  pickImages: vi.fn(),
  pickFolder: vi.fn(),
  pickProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickBackgroundImage: vi.fn(),
}));

import { importModel, updateSettings as updateApi } from '@/api/settings';
import { pickModelFile } from '@/api/dialogs';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { SettingsDialog } from './SettingsDialog';

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, loaded: true });
  useUiStore.setState({ settingsOpen: true, notices: [] });
});

const lastSaved = () =>
  vi.mocked(updateApi).mock.calls.at(-1)?.[0] as typeof DEFAULT_SETTINGS | undefined;

async function openTab(name: string) {
  render(<SettingsDialog />);
  await userEvent.click(await screen.findByRole('tab', { name }));
}

describe('Settings dialog', () => {
  it('has the five tabs from the spec', async () => {
    render(<SettingsDialog />);
    for (const name of ['General', 'Model', 'Export', 'Shortcuts', 'About']) {
      expect(await screen.findByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('persists the autosave interval', async () => {
    render(<SettingsDialog />);
    const field = await screen.findByRole('textbox', { name: 'Autosave every' });
    await userEvent.clear(field);
    await userEvent.type(field, '120');
    await userEvent.tab();
    expect(lastSaved()?.autosaveSeconds).toBe(120);
  });

  it('clamps autosave interval to the allowed range', async () => {
    render(<SettingsDialog />);
    const field = await screen.findByRole('textbox', { name: 'Autosave every' });
    await userEvent.clear(field);
    await userEvent.type(field, '2');
    await userEvent.tab();
    expect(lastSaved()?.autosaveSeconds).toBe(10);
  });

  it('switches model and processing, with the GPU fallback note', async () => {
    await openTab('Model');
    expect(screen.getByText(/Falls back to CPU automatically/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /GPU if available/ }));
    expect(lastSaved()?.processing).toBe('gpuIfAvailable');
    await userEvent.click(screen.getByRole('radio', { name: /Quality/ }));
    expect(lastSaved()?.modelType).toBe('quality');
    expect(await screen.findByText(/Installed|Not installed/)).toBeInTheDocument();
  });

  it('imports a model file and reports success', async () => {
    vi.mocked(pickModelFile).mockResolvedValue('/downloads/birefnet.onnx');
    vi.mocked(importModel).mockResolvedValue(undefined);
    await openTab('Model');
    await userEvent.click(screen.getByRole('button', { name: 'Import model file...' }));
    expect(importModel).toHaveBeenCalledWith('fast', '/downloads/birefnet.onnx');
    expect(useUiStore.getState().notices.at(-1)?.kind).toBe('success');
  });

  it('shows a clear error when the model file is rejected', async () => {
    vi.mocked(pickModelFile).mockResolvedValue('/downloads/bad.onnx');
    vi.mocked(importModel).mockRejectedValue({
      code: 'ModelLoad',
      message: 'not a model',
      details: null,
    });
    await openTab('Model');
    await userEvent.click(screen.getByRole('button', { name: 'Import model file...' }));
    expect(useUiStore.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      message: 'The model could not be loaded.',
    });
  });

  it('lets you pick and clear the default export folder', async () => {
    await openTab('Export');
    await userEvent.click(screen.getByRole('button', { name: 'Browse...' }));
    expect(lastSaved()?.defaultExportFolder).toBe('/exports');
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(lastSaved()?.defaultExportFolder).toBeNull();
  });

  it('About lists the version and the model licence', async () => {
    await openTab('About');
    expect(await screen.findByText('Photom 0.1.0')).toBeInTheDocument();
    expect(screen.getByText('isnet-general-use.onnx: Apache-2.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open logs folder' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  });

  it('shows the third-party licences on demand', async () => {
    await openTab('About');
    const button = await screen.findByRole('button', { name: 'View licences' });
    expect(screen.queryByLabelText('Licences', { selector: 'pre' })).not.toBeInTheDocument(); // not loaded yet
    await userEvent.click(button);
    expect(await screen.findByText(/MIT License/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide licences' }));
    expect(screen.queryByText(/MIT License/)).not.toBeInTheDocument();
  });
});

describe('Shortcuts tab', () => {
  const row = (label: string) =>
    screen.getByRole('button', { name: `Change ${label}` }).closest('tr')!;

  it('remaps a shortcut and saves only the difference from the defaults', async () => {
    await openTab('Shortcuts');
    await userEvent.click(screen.getByRole('button', { name: 'Change Undo' }));
    expect(screen.getByText('Press keys...')).toBeInTheDocument();
    await userEvent.keyboard('{Control>}u{/Control}');
    expect(lastSaved()?.shortcuts).toEqual({ undo: ['mod+u'] });
    expect(within(row('Undo')).getByText(/U$/)).toBeInTheDocument();
  });

  it('refuses a combo that another action already uses', async () => {
    await openTab('Shortcuts');
    await userEvent.click(screen.getByRole('button', { name: 'Change Undo' }));
    await userEvent.keyboard('{Control>}s{/Control}');
    expect(await screen.findByText('Already used by "Save".')).toBeInTheDocument();
    expect(updateApi).not.toHaveBeenCalled();
  });

  it('Escape cancels recording without changing anything', async () => {
    await openTab('Shortcuts');
    await userEvent.click(screen.getByRole('button', { name: 'Change Undo' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Press keys...')).not.toBeInTheDocument();
    expect(updateApi).not.toHaveBeenCalled();
  });

  it('Reset to defaults clears every override', async () => {
    useSettingsStore.setState({ shortcuts: { undo: ['mod+u'], redo: ['mod+j'] } });
    await openTab('Shortcuts');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(lastSaved()?.shortcuts).toEqual({});
  });

  it('per-row Reset is only enabled for changed shortcuts', async () => {
    useSettingsStore.setState({ shortcuts: { undo: ['mod+u'] } });
    await openTab('Shortcuts');
    expect(screen.getByRole('button', { name: 'Reset Undo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset Redo' })).toBeDisabled();
  });
});
