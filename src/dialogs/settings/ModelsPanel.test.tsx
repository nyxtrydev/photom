import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/models', () => ({
  installModel: vi.fn().mockResolvedValue(undefined),
  installModels: vi.fn().mockResolvedValue(1),
  installRecommended: vi.fn().mockResolvedValue(2),
  installAll: vi.fn().mockResolvedValue(0),
  pauseModel: vi.fn().mockResolvedValue(undefined),
  resumeModel: vi.fn().mockResolvedValue(undefined),
  cancelModel: vi.fn().mockResolvedValue(undefined),
  openModelsFolder: vi.fn().mockResolvedValue(undefined),
  listModels: vi.fn().mockResolvedValue([]),
  catalogStatus: vi.fn().mockResolvedValue(null),
  refreshCatalog: vi.fn(),
  importModelFile: vi.fn().mockResolvedValue(undefined),
  removeModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/settings', () => ({
  updateSettings: vi.fn(async (s: unknown) => s),
}));
vi.mock('@/api/dialogs', () => ({
  pickModelFile: vi.fn(),
}));

import { pickModelFile } from '@/api/dialogs';
import * as api from '@/api/models';
import { updateSettings as updateSettingsApi } from '@/api/settings';
import { ModelsPanel } from '@/dialogs/settings/ModelsPanel';
import { useHubStore } from '@/stores/hubStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { model, seedHub, withState } from '@/test/hubFixtures';

const catalog = () => [
  model('bgremoval-fast', {
    name: 'Background Remover (Fast)',
    feature: 'background-removal',
    sizeBytes: 90_000_000,
    state: withState('installed'),
    source: 'bundled',
    installedVersion: '1.0.0',
    installable: false,
    verified: true,
  }),
  model('upscale-x2', { name: 'Upscaler x2', feature: 'upscale', sizeBytes: 65_000_000 }),
  model('upscale-x4', {
    name: 'Upscaler x4',
    feature: 'upscale',
    state: withState('downloading'),
  }),
  model('denoise-ai', {
    name: 'AI Denoise',
    feature: 'enhancement',
    installable: false,
    sha256: '0'.repeat(64),
  }),
];

describe('ModelsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedHub(catalog());
    useSettingsStore.setState({ modelsOnboardingDone: true });
  });

  it('lists every model with its feature, version, size, licence and status', () => {
    render(<ModelsPanel />);
    const row = screen.getByTestId('model-upscale-x2');
    expect(within(row).getByText('Upscaler x2', { selector: 'p' })).toBeVisible();
    expect(within(row).getByText(/Image Upscaler · v1\.0\.0 · 65 MB · Apache-2\.0/)).toBeVisible();
    expect(screen.getByTestId('status-upscale-x2')).toHaveTextContent('Not installed');
    expect(screen.getByTestId('status-bgremoval-fast')).toHaveTextContent('Included');
    expect(screen.getByTestId('status-denoise-ai')).toHaveTextContent('Not available yet');
  });

  it('installs, pauses and cancels per model', async () => {
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Install Upscaler x2' }));
    expect(api.installModel).toHaveBeenCalledWith('upscale-x2');
    await userEvent.click(screen.getByRole('button', { name: 'Pause Upscaler x4' }));
    expect(api.pauseModel).toHaveBeenCalledWith('upscale-x4');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Upscaler x4' }));
    expect(api.cancelModel).toHaveBeenCalledWith('upscale-x4');
  });

  it('cannot install a model that is not published yet', () => {
    render(<ModelsPanel />);
    expect(screen.getByRole('button', { name: 'Install AI Denoise' })).toBeDisabled();
  });

  it('shows a live percentage and progress bar for a download', () => {
    render(<ModelsPanel />);
    act(() =>
      useHubStore.getState().setProgress({
        id: 'upscale-x4',
        downloadedBytes: 35_000_000,
        totalBytes: 70_000_000,
        speedBps: 1,
        etaSeconds: 1,
      }),
    );
    expect(screen.getByTestId('status-upscale-x4')).toHaveTextContent('Downloading 50%');
    const row = screen.getByTestId('model-upscale-x4');
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('offers Resume for a paused download and Update for an outdated one', async () => {
    seedHub([
      model('a', { name: 'A', state: withState('paused') }),
      model('b', { name: 'B', state: withState('updateAvailable'), installedVersion: '0.9.0' }),
    ]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume A' }));
    expect(api.resumeModel).toHaveBeenCalledWith('a');
    await userEvent.click(screen.getByRole('button', { name: 'Update B' }));
    expect(api.installModel).toHaveBeenCalledWith('b');
    expect(screen.getByTestId('status-b')).toHaveTextContent('Update available');
  });

  it('shows a failure with a retry', async () => {
    seedHub([
      model('a', { name: 'A', state: { kind: 'failed', code: 'HashMismatch', message: '' } }),
    ]);
    render(<ModelsPanel />);
    expect(screen.getByText(/corrupted and has been discarded/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry A' }));
    expect(api.installModel).toHaveBeenCalledWith('a');
  });

  it('expands details: licence, attribution and checksum', async () => {
    render(<ModelsPanel />);
    const row = screen.getByTestId('model-upscale-x2');
    const toggle = within(row).getByRole('button', { name: /Details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByText(/Commercial use allowed/)).toBeVisible();
    expect(within(row).getByText('By Someone')).toBeVisible();
    expect(within(row).getByText('ab'.repeat(32))).toBeVisible();
    expect(within(row).getByText('https://example.org/licence')).toBeVisible();
  });

  it('says when a checksum is not published yet', async () => {
    render(<ModelsPanel />);
    const row = screen.getByTestId('model-denoise-ai');
    await userEvent.click(within(row).getByRole('button', { name: /Details/ }));
    expect(within(row).getByText('Not published yet')).toBeVisible();
  });

  it('has the header actions', async () => {
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Install recommended' }));
    expect(api.installRecommended).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Install all' }));
    expect(api.installAll).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open models folder' }));
    expect(api.openModelsFolder).toHaveBeenCalled();
    // The recommended call said "2 queued", the all call "nothing to install".
    const messages = useUiStore.getState().notices.map((n) => n.message);
    expect(messages).toEqual(['Queued 2 model(s).', 'No downloads are available yet.']);
  });

  it('checks for catalog updates and reports offline problems', async () => {
    vi.mocked(api.refreshCatalog).mockResolvedValue({
      models: catalog(),
      source: 'bundled',
      generatedAt: '2026-01-01T00:00:00Z',
      warning: 'You are offline or the catalog server is unreachable.',
    });
    useUiStore.setState({ notices: [] });
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(useUiStore.getState().notices[0]?.message).toMatch(/offline/);
    expect(screen.getByText(/Offline catalog \(bundled\)/)).toBeVisible();
  });

  it('summarises disk use and the catalog source', () => {
    render(<ModelsPanel />);
    // Only the installed (bundled) model counts.
    expect(screen.getByText('Installed models use about 90 MB on disk.')).toBeVisible();
    expect(screen.getByText(/Offline catalog \(bundled\)\. It may be out of date\./)).toBeVisible();
    act(() =>
      useHubStore.getState().setCatalog({
        source: 'remote',
        generatedAt: '2026-02-01T00:00:00Z',
        warning: null,
      }),
    );
    expect(screen.getByText('Online catalog')).toBeVisible();
  });

  it('can re-enable the first-run offer', async () => {
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Show the first-run offer again' }));
    expect(useSettingsStore.getState().modelsOnboardingDone).toBe(false);
  });
});

describe('ModelsPanel: import, remove and advanced settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ notices: [], confirm: null });
    useSettingsStore.setState({
      modelsOnboardingDone: true,
      modelsCatalogUrl: null,
      modelsExtraHost: null,
    });
  });

  const installedHub = (over: Partial<ReturnType<typeof model>> = {}) =>
    model('a', {
      name: 'A',
      state: withState('installed'),
      source: 'hub',
      verified: true,
      removable: true,
      installedVersion: '1.0.0',
      ...over,
    });

  it('removes only after confirmation, then reports it', async () => {
    seedHub([installedHub()]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove A' }));
    // The confirm dialog is app-wide state; answer it like the dialog component would.
    const req = useUiStore.getState().confirm!;
    expect(req.title).toBe('Remove A?');
    expect(api.removeModel).not.toHaveBeenCalled();
    await act(async () => req.resolve('remove'));
    await vi.waitFor(() => expect(api.removeModel).toHaveBeenCalledWith('a'));
    await vi.waitFor(() =>
      expect(useUiStore.getState().notices.map((n) => n.message)).toContain('A was removed.'),
    );
  });

  it('keeping the model removes nothing', async () => {
    seedHub([installedHub()]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove A' }));
    await act(async () => useUiStore.getState().confirm!.resolve('keep'));
    expect(api.removeModel).not.toHaveBeenCalled();
  });

  it('bundled models have no Remove button', () => {
    seedHub([installedHub({ source: 'bundled', removable: false })]);
    render(<ModelsPanel />);
    expect(screen.queryByRole('button', { name: 'Remove A' })).toBeNull();
  });

  it('marks an imported, unverified model', () => {
    seedHub([installedHub({ source: 'imported', verified: false })]);
    render(<ModelsPanel />);
    expect(screen.getByTestId('unverified-a')).toHaveTextContent('Unverified file');
    seedHub([installedHub({ source: 'imported', verified: true })]);
  });

  it('imports a matching file straight away', async () => {
    vi.mocked(pickModelFile).mockResolvedValue('/files/m.onnx');
    seedHub([model('a', { name: 'A' })]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Import file A' }));
    await vi.waitFor(() =>
      expect(api.importModelFile).toHaveBeenCalledWith('a', '/files/m.onnx', false),
    );
    expect(useUiStore.getState().confirm).toBeNull();
    await vi.waitFor(() =>
      expect(useUiStore.getState().notices[0]?.message).toBe('A was imported and verified.'),
    );
  });

  it('asks for explicit consent before accepting an unverified file', async () => {
    vi.mocked(pickModelFile).mockResolvedValue('/files/other.onnx');
    vi.mocked(api.importModelFile).mockRejectedValueOnce({
      code: 'Unverified',
      message: 'x',
      details: null,
    });
    seedHub([model('a', { name: 'A' })]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Import file A' }));
    await vi.waitFor(() => expect(useUiStore.getState().confirm).not.toBeNull());
    const req = useUiStore.getState().confirm!;
    expect(req.buttons.map((b) => b.label)).toContain('I understand this file is unverified');
    expect(api.importModelFile).toHaveBeenCalledTimes(1);
    await act(async () => req.resolve('import'));
    await vi.waitFor(() =>
      expect(api.importModelFile).toHaveBeenLastCalledWith('a', '/files/other.onnx', true),
    );
    await vi.waitFor(() =>
      expect(useUiStore.getState().notices[0]?.message).toMatch(/marked as unverified/),
    );
  });

  it('declining the warning imports nothing', async () => {
    vi.mocked(pickModelFile).mockResolvedValue('/files/other.onnx');
    vi.mocked(api.importModelFile).mockRejectedValueOnce({
      code: 'Unverified',
      message: 'x',
      details: null,
    });
    seedHub([model('a', { name: 'A' })]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Import file A' }));
    await vi.waitFor(() => expect(useUiStore.getState().confirm).not.toBeNull());
    await act(async () => useUiStore.getState().confirm!.resolve('cancel'));
    expect(api.importModelFile).toHaveBeenCalledTimes(1);
  });

  it('cancelling the file picker does nothing', async () => {
    vi.mocked(pickModelFile).mockResolvedValue(null);
    seedHub([model('a', { name: 'A' })]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Import file A' }));
    expect(api.importModelFile).not.toHaveBeenCalled();
  });

  it('shows other import failures as a normal error toast', async () => {
    vi.mocked(pickModelFile).mockResolvedValue('/files/m.txt');
    vi.mocked(api.importModelFile).mockRejectedValueOnce({
      code: 'UnsupportedFormat',
      message: 'expects a .onnx file',
      details: null,
    });
    seedHub([model('a', { name: 'A' })]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Import file A' }));
    await vi.waitFor(() => expect(useUiStore.getState().notices[0]?.kind).toBe('error'));
  });

  it('saves the advanced settings, validating them first', async () => {
    seedHub([model('a')]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const url = screen.getByLabelText('Catalog URL');
    const host = screen.getByLabelText('Extra download host');

    await userEvent.type(url, 'http://insecure.example/c.json');
    await userEvent.type(host, 'https://x.example/path');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter an https:// address.')).toBeVisible();
    expect(screen.getByText('Enter just a host name, without https:// or a path.')).toBeVisible();
    expect(updateSettingsApi).not.toHaveBeenCalled();

    await userEvent.clear(url);
    await userEvent.clear(host);
    await userEvent.type(url, 'https://mirror.example/c.json');
    await userEvent.type(host, 'files.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(updateSettingsApi).toHaveBeenCalledWith(
        expect.objectContaining({
          modelsCatalogUrl: 'https://mirror.example/c.json',
          modelsExtraHost: 'files.example',
        }),
      ),
    );
    expect(useUiStore.getState().notices.at(-1)?.message).toBe('Download settings saved.');
  });

  it('resets the advanced settings to defaults', async () => {
    useSettingsStore.setState({
      modelsCatalogUrl: 'https://mirror.example/c.json',
      modelsExtraHost: 'files.example',
    });
    seedHub([model('a')]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByLabelText('Catalog URL')).toHaveValue('https://mirror.example/c.json');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await vi.waitFor(() =>
      expect(updateSettingsApi).toHaveBeenCalledWith(
        expect.objectContaining({ modelsCatalogUrl: null, modelsExtraHost: null }),
      ),
    );
    expect(screen.getByLabelText('Catalog URL')).toHaveValue('');
  });

  it('tells the user when the backend ignored a value', async () => {
    vi.mocked(updateSettingsApi).mockImplementationOnce(async (s) => ({
      ...s,
      modelsExtraHost: null,
    }));
    seedHub([model('a')]);
    render(<ModelsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    await userEvent.type(screen.getByLabelText('Extra download host'), 'ok.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(useUiStore.getState().notices.at(-1)?.message).toBe(
        'Some values were not valid and were ignored.',
      ),
    );
  });
});
