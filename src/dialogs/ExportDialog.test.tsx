import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/export', () => ({
  exportPng: vi.fn().mockResolvedValue('job-1'),
  getJob: vi.fn().mockResolvedValue({
    jobId: 'job-1',
    kind: 'export',
    status: 'running',
    done: 0,
    total: 1,
    items: [],
  }),
  saveExportPreset: vi.fn().mockResolvedValue([]),
  deleteExportPreset: vi.fn().mockResolvedValue([]),
  removeBackgroundBatch: vi.fn(),
  cancelJob: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  copyToClipboard: vi.fn(),
  listHistory: vi.fn(),
  deleteHistoryItem: vi.fn(),
  clearHistory: vi.fn(),
}));
vi.mock('@/api/dialogs', () => ({
  pickExportFolder: vi.fn().mockResolvedValue('/picked'),
  pickImages: vi.fn(),
  pickFolder: vi.fn(),
  pickProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickBackgroundImage: vi.fn(),
  pickModelFile: vi.fn(),
}));
vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(async (s: unknown) => s),
  revealPath: vi.fn(),
  getAppInfo: vi.fn(),
  importModel: vi.fn(),
  openLogsFolder: vi.fn(),
  removeRecentProject: vi.fn(),
  clearRecentProjects: vi.fn(),
  pathsExist: vi.fn(),
}));

import { pickExportFolder } from '@/api/dialogs';
import { deleteExportPreset, exportPng, saveExportPreset } from '@/api/export';
import { getSettings } from '@/api/settings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { ExportDialog } from './ExportDialog';

const meta = (id: string) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: 400,
  height: 200,
  format: 'jpeg',
  thumbnailPath: '',
});
const mask = (id: string) => ({
  id,
  maskPath: `/m/${id}.png`,
  width: 400,
  height: 200,
  boundingBox: null,
  durationMs: 1,
  device: 'cpu' as const,
});

function open(request: { scope?: 'current' | 'all'; presetId?: string } = {}) {
  useUiStore.setState({ exportDialog: request });
  return render(<ExportDialog />);
}

const sentOptions = () => vi.mocked(exportPng).mock.calls[0]![1];
const sentItems = () => vi.mocked(exportPng).mock.calls[0]![0];

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ exportDialog: null, notices: [] });
  useQueueStore.setState({ jobs: {}, requests: {}, dialogJobId: null, reported: {} });
  useSettingsStore.setState({
    ...DEFAULT_SETTINGS,
    loaded: true,
    lastUsedFolders: { export: '/exports' },
  });
  useProjectStore.getState().load({
    name: 'p',
    path: null,
    images: [meta('a'), meta('b')],
    masks: { a: mask('a'), b: mask('b') },
    dirty: false,
  });
  useEditorStore.setState({ states: {}, activeId: null });
  useEditorStore.getState().ensureState('a', 400, 200);
  useEditorStore.getState().ensureState('b', 400, 200);
  useEditorStore.getState().setActive('a');
});

describe('Export dialog', () => {
  it('shows every section from the mockup with sensible defaults', async () => {
    open();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Export PNG')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Current image' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /All images \(2\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Transparent' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Original size' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Crop to subject' })).not.toBeChecked();
    expect(within(dialog).getByRole('textbox', { name: 'Filename' })).toHaveValue(
      '{name}-photom.png',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Folder' })).toHaveValue('/exports'); // remembered
    expect(within(dialog).getByRole('slider', { name: 'PNG compression' })).toHaveAttribute(
      'aria-valuenow',
      '6',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Preset' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it("exports the current image with the default options, sending that image's own editor state", async () => {
    useEditorStore.getState().setRefine('a', { threshold: 77 });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(exportPng).toHaveBeenCalledOnce();
    expect(sentItems()).toHaveLength(1);
    expect(sentItems()[0]).toMatchObject({ id: 'a', state: { refine: { threshold: 77 } } });
    expect(sentOptions()).toMatchObject({
      background: 'transparent',
      size: { mode: 'original' },
      crop: { enabled: false },
      compression: 6,
      filenameTemplate: '{name}-photom.png',
      folder: '/exports',
    });
    expect(sentOptions()).not.toHaveProperty('scope');
    expect(useUiStore.getState().exportDialog).toBeNull(); // dialog closed
    expect(useQueueStore.getState().dialogJobId).toBeNull(); // single image: toast only, no batch dialog
  });

  it('All images exports every image and opens the batch progress dialog', async () => {
    open();
    await userEvent.click(await screen.findByRole('radio', { name: /All images/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(sentItems().map((i) => i.id)).toEqual(['a', 'b']);
    expect(useQueueStore.getState().dialogJobId).toBe('job-1');
  });

  it('opens straight to "All images" when launched as batch export', async () => {
    open({ scope: 'all' });
    expect(await screen.findByRole('radio', { name: /All images/ })).toBeChecked();
  });

  it('requires an output folder', async () => {
    useSettingsStore.setState({ lastUsedFolders: {}, defaultExportFolder: null });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an output folder.');
    expect(exportPng).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Browse...' }));
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('/picked');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(exportPng).toHaveBeenCalled();
  });

  it('custom size keeps the aspect ratio when locked and exact values when unlocked', async () => {
    open();
    await userEvent.click(await screen.findByRole('radio', { name: 'Custom' }));
    const w = screen.getByRole('textbox', { name: 'Width' });
    await userEvent.clear(w);
    await userEvent.type(w, '100');
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'Height' })).toHaveValue('50'); // 400x200 source ratio

    await userEvent.click(screen.getByRole('button', { name: 'Lock aspect ratio' }));
    const h = screen.getByRole('textbox', { name: 'Height' });
    await userEvent.clear(h);
    await userEvent.type(h, '77');
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'Width' })).toHaveValue('100'); // unchanged when unlocked

    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(sentOptions().size).toMatchObject({ mode: 'custom', width: 100, height: 77 });
  });

  it('crop padding is only editable when crop is on and is sent exactly', async () => {
    open();
    const padding = await screen.findByRole('textbox', { name: 'Padding' });
    expect(padding).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Crop to subject' }));
    expect(padding).toBeEnabled();
    await userEvent.clear(padding);
    await userEvent.type(padding, '24');
    await userEvent.tab();
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(sentOptions().crop).toEqual({ enabled: true, padding: 24 });
  });

  it('background choice, template and compression reach the backend', async () => {
    open();
    await userEvent.click(await screen.findByRole('radio', { name: 'Keep selected background' }));
    const name = screen.getByRole('textbox', { name: 'Filename' });
    await userEvent.clear(name);
    await userEvent.type(name, '{{index}_{{name}');
    const slider = screen.getByRole('slider', { name: 'PNG compression' });
    slider.focus();
    await userEvent.keyboard('{End}');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(sentOptions()).toMatchObject({
      background: 'keepSelected',
      filenameTemplate: '{index}_{name}',
      compression: 9,
    });
  });

  it('shows a live filename example and warns about images without a cut-out', async () => {
    useProjectStore.getState().setMaskFor('b', null);
    open({ scope: 'all' });
    expect(await screen.findByText('Example: a-photom.png')).toBeInTheDocument();
    expect(screen.getByText(/1 image has no cut-out yet/)).toBeInTheDocument();
  });

  it('choosing a built-in preset applies its settings and the dropdown tracks matches', async () => {
    open();
    const select = await screen.findByRole('combobox', { name: 'Preset' });
    await userEvent.selectOptions(select, 'web');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(sentOptions()).toMatchObject({
      compression: 9,
      size: { mode: 'original', maxSide: 2000 },
    });
  });

  it('manual changes switch the preset dropdown to Custom', async () => {
    open({ presetId: 'web' });
    const select = await screen.findByRole('combobox', { name: 'Preset' });
    expect(select).toHaveValue('web');
    const slider = screen.getByRole('slider', { name: 'PNG compression' });
    slider.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(select).toHaveValue('__custom');
  });

  it('saves the current settings as a named preset', async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS });
    open();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Crop to subject' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Preset name' }), 'My shop');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const saved = vi.mocked(saveExportPreset).mock.calls[0]![0];
    expect(saved).toMatchObject({
      name: 'My shop',
      options: { crop: { enabled: true }, compression: 6 },
    });
    expect(saved.options).not.toHaveProperty('folder');
  });

  it('renames and deletes custom presets', async () => {
    const mine = {
      id: 'mine',
      name: 'Shop',
      options: {
        background: 'transparent',
        sizeMode: 'original',
        maxSide: null,
        crop: { enabled: true, padding: 5 },
        compression: 2,
      },
    };
    useSettingsStore.setState({ exportPresets: [mine] });
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, exportPresets: [] });
    open({ presetId: 'mine' });
    expect(await screen.findByRole('combobox', { name: 'Preset' })).toHaveValue('mine');

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Preset name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Shop v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(vi.mocked(saveExportPreset).mock.calls[0]![0]).toMatchObject({
      id: 'mine',
      name: 'Shop v2',
    });

    useSettingsStore.setState({ exportPresets: [mine] });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteExportPreset).toHaveBeenCalledWith('mine');
  });

  it('built-in presets cannot be renamed or deleted', async () => {
    open({ presetId: 'web' });
    await screen.findByRole('combobox', { name: 'Preset' });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('Cancel closes without exporting; backend errors are reported and keep the dialog open', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(exportPng).not.toHaveBeenCalled();
    expect(useUiStore.getState().exportDialog).toBeNull();

    vi.mocked(exportPng).mockRejectedValueOnce({
      code: 'Permission',
      message: 'read-only folder',
      details: null,
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(useUiStore.getState().notices.at(-1)).toMatchObject({ kind: 'error' });
    expect(useUiStore.getState().exportDialog).not.toBeNull();
  });

  it('remembers the chosen folder for next time', async () => {
    open();
    const folder = await screen.findByRole('textbox', { name: 'Folder' });
    await userEvent.clear(folder);
    await userEvent.type(folder, '/somewhere/else');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    const { updateSettings } = await import('@/api/settings');
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(vi.mocked(updateSettings).mock.calls.at(-1)![0]).toMatchObject({
      lastUsedFolders: { export: '/somewhere/else' },
    });
    expect(pickExportFolder).not.toHaveBeenCalled();
  });
});
