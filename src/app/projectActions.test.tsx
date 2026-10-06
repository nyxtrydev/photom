import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/project', () => ({
  saveProject: vi.fn(),
  openProject: vi.fn(),
  projectBackupPath: vi.fn(),
  resetSession: vi.fn().mockResolvedValue(undefined),
  autosaveProject: vi.fn(),
  listRecovery: vi.fn(),
  restoreRecovery: vi.fn(),
  discardRecovery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/api/dialogs', () => ({
  pickProject: vi.fn(),
  pickProjectSavePath: vi.fn(),
  pickImages: vi.fn(),
  pickFolder: vi.fn(),
  pickBackgroundImage: vi.fn(),
}));
vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  removeRecentProject: vi.fn(),
  clearRecentProjects: vi.fn(),
  pathsExist: vi.fn(),
  revealPath: vi.fn(),
  getAppInfo: vi.fn(),
  importModel: vi.fn(),
  openLogsFolder: vi.fn(),
}));

import { pickProject, pickProjectSavePath } from '@/api/dialogs';
import {
  discardRecovery,
  openProject as openProjectApi,
  projectBackupPath,
  resetSession,
  restoreRecovery,
  saveProject as saveProjectApi,
} from '@/api/project';
import { getSettings } from '@/api/settings';
import { ConfirmDialog } from '@/dialogs/ConfirmDialog';
import { RecoveryDialog } from '@/dialogs/RecoveryDialog';
import { useDirtyTracking } from '@/hooks/useProjectLifecycle';
import { useEditorStore } from '@/stores/editorStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores/projectStore';
import { useUiStore } from '@/stores/uiStore';
import type { OpenedProject } from '@/types/dto';
import {
  buildPayload,
  confirmDiscardChanges,
  newProject,
  openProject,
  projectTitle,
  saveProject,
} from './projectActions';

const meta = (id: string) => ({
  id,
  path: `/x/${id}.jpg`,
  name: `${id}.jpg`,
  width: 400,
  height: 300,
  format: 'jpeg',
  thumbnailPath: `/t/${id}.png`,
});

const opened = (over: Partial<OpenedProject> = {}): OpenedProject => ({
  meta: {
    projectId: 'p-1',
    name: 'saved',
    path: null,
    modified: 't',
    formatVersion: 1,
    activeId: 'b',
  },
  images: [
    { meta: meta('a'), state: {}, mask: null },
    {
      meta: meta('b'),
      state: {
        refine: { threshold: 80, feather: 1, edgeShift: 2 },
        strokes: [{ mode: 'keep', size: 5, hardness: 5, points: [[1, 1, 1]] }],
      },
      mask: {
        id: 'b',
        maskPath: '/m/b.png',
        width: 400,
        height: 300,
        boundingBox: null,
        durationMs: 0,
        device: 'cpu',
      },
    },
  ],
  warnings: [],
  ...over,
});

function seedProject() {
  useProjectStore.getState().addImages([meta('a')]);
  useEditorStore.getState().ensureState('a', 400, 300);
  useEditorStore.getState().setActive('a');
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    screen: 'home',
    notices: [],
    confirm: null,
    recovery: [],
    lastAutosave: null,
  });
  useEditorStore.setState({ states: {}, activeId: null });
  useProjectStore
    .getState()
    .load({ name: 'Untitled', path: null, images: [], masks: {}, dirty: false });
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, loaded: true });
  vi.mocked(getSettings).mockResolvedValue(DEFAULT_SETTINGS);
});

describe('saving', () => {
  it('Save on an untitled project asks for a path, writes it and marks the project clean', async () => {
    seedProject();
    useProjectStore.getState().setDirty(true);
    vi.mocked(pickProjectSavePath).mockResolvedValue('/docs/dog.photom');
    vi.mocked(saveProjectApi).mockResolvedValue({
      projectId: 'p',
      name: 'dog',
      path: '/docs/dog.photom',
      modified: 't',
      formatVersion: 1,
      activeId: 'a',
    });

    expect(await saveProject()).toBe(true);

    const [payload, path] = vi.mocked(saveProjectApi).mock.calls[0]!;
    expect(path).toBe('/docs/dog.photom');
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]!.id).toBe('a');
    const s = useProjectStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.path).toBe('/docs/dog.photom');
    expect(s.name).toBe('dog');
    expect(useUiStore.getState().notices.at(-1)?.kind).toBe('success');
  });

  it('Save on a saved project does not ask for a path again', async () => {
    seedProject();
    useProjectStore.setState({ path: '/docs/dog.photom', name: 'dog', dirty: true });
    vi.mocked(saveProjectApi).mockResolvedValue({
      projectId: 'p',
      name: 'dog',
      path: '/docs/dog.photom',
      modified: 't',
      formatVersion: 1,
      activeId: 'a',
    });
    await saveProject();
    expect(pickProjectSavePath).not.toHaveBeenCalled();
    expect(saveProjectApi).toHaveBeenCalledOnce();
  });

  it('a cancelled Save As dialog saves nothing', async () => {
    seedProject();
    vi.mocked(pickProjectSavePath).mockResolvedValue(null);
    expect(await saveProject()).toBe(false);
    expect(saveProjectApi).not.toHaveBeenCalled();
  });

  it('a failed save keeps the project dirty and reports the error', async () => {
    seedProject();
    useProjectStore.setState({ path: '/docs/dog.photom', dirty: true });
    vi.mocked(saveProjectApi).mockRejectedValue({
      code: 'Permission',
      message: 'read-only',
      details: null,
    });
    expect(await saveProject()).toBe(false);
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useUiStore.getState().notices.at(-1)?.kind).toBe('error');
  });

  it('refuses to save an empty project', async () => {
    expect(await saveProject()).toBe(false);
    expect(saveProjectApi).not.toHaveBeenCalled();
    expect(useUiStore.getState().notices.at(-1)?.kind).toBe('info');
  });

  it('serialises only persisted editor state, not history or viewport', () => {
    seedProject();
    useEditorStore.getState().setRefine('a', { threshold: 77 });
    useEditorStore.getState().commitRefine('a');
    useEditorStore.getState().setViewport('a', { zoom: 2, panX: 1, panY: 1 });
    const state = buildPayload().images[0]!.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual([
      'background',
      'output',
      'refine',
      'split',
      'strokes',
    ]);
    expect((state.refine as { threshold: number }).threshold).toBe(77);
  });
});

describe('unsaved-changes guard', () => {
  const choose = async (name: string) => {
    render(<ConfirmDialog />);
    const btn = await screen.findByRole('button', { name });
    await userEvent.click(btn);
  };

  it('passes straight through when nothing is dirty', async () => {
    expect(await confirmDiscardChanges()).toBe(true);
    expect(useUiStore.getState().confirm).toBeNull();
  });

  it('Cancel stops New project and keeps everything', async () => {
    seedProject();
    useProjectStore.getState().setDirty(true);
    const p = newProject();
    await choose('Cancel');
    await p;
    expect(useProjectStore.getState().images).toHaveLength(1);
    expect(resetSession).not.toHaveBeenCalled();
  });

  it("Don't save discards the changes and starts a new project", async () => {
    seedProject();
    useProjectStore.getState().setDirty(true);
    const oldId = useProjectStore.getState().projectId;
    const p = newProject();
    await choose("Don't save");
    await p;
    expect(useProjectStore.getState().images).toHaveLength(0);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(resetSession).toHaveBeenCalled();
    expect(discardRecovery).toHaveBeenCalledWith(oldId); // its autosave is dropped
  });

  it('Save writes the project first, then continues', async () => {
    seedProject();
    useProjectStore.setState({ path: '/docs/p.photom', dirty: true });
    vi.mocked(saveProjectApi).mockResolvedValue({
      projectId: 'p',
      name: 'p',
      path: '/docs/p.photom',
      modified: 't',
      formatVersion: 1,
      activeId: 'a',
    });
    const p = newProject();
    await choose('Save');
    await p;
    expect(saveProjectApi).toHaveBeenCalled();
    expect(useProjectStore.getState().images).toHaveLength(0);
  });

  it('closing the dialog with Escape counts as Cancel', async () => {
    seedProject();
    useProjectStore.getState().setDirty(true);
    render(<ConfirmDialog />);
    const p = confirmDiscardChanges();
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(await p).toBe(false);
  });
});

describe('opening projects', () => {
  it('loads images, sanitised editor state and masks, and starts clean in the editor', async () => {
    vi.mocked(pickProject).mockResolvedValue('/docs/saved.photom');
    vi.mocked(openProjectApi).mockResolvedValue(opened());
    await openProject();
    const ed = useEditorStore.getState();
    expect(ed.activeId).toBe('b');
    expect(ed.states['b']!.refine).toEqual({ threshold: 80, feather: 1, edgeShift: 2 });
    expect(ed.states['b']!.strokes).toHaveLength(1);
    expect(ed.states['a']!.refine.threshold).toBe(50); // missing state -> defaults
    const p = useProjectStore.getState();
    expect(p.images.map((i) => i.id)).toEqual(['a', 'b']);
    expect(p.masks['b']?.maskPath).toBe('/m/b.png');
    expect(p.dirty).toBe(false);
    expect(p.name).toBe('saved');
    expect(useUiStore.getState().screen).toBe('edit');
  });

  it('shows warnings for originals that went missing', async () => {
    vi.mocked(openProjectApi).mockResolvedValue(
      opened({ warnings: ['c.jpg: the original file is missing'] }),
    );
    await openProject('/docs/saved.photom');
    expect(useUiStore.getState().notices.some((n) => n.kind === 'warning')).toBe(true);
  });

  it('a corrupt project with a backup offers it and opens it as unsaved work', async () => {
    vi.mocked(openProjectApi)
      .mockRejectedValueOnce({ code: 'ProjectCorrupt', message: 'bad zip', details: null })
      .mockResolvedValueOnce(opened());
    vi.mocked(projectBackupPath).mockResolvedValue('/docs/saved.photom.bak');
    render(<ConfirmDialog />);
    const p = openProject('/docs/saved.photom');
    await userEvent.click(await screen.findByRole('button', { name: 'Open backup' }));
    await p;
    expect(vi.mocked(openProjectApi).mock.calls[1]![0]).toBe('/docs/saved.photom.bak');
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().path).toBeNull(); // never silently overwrite the damaged original
  });

  it('a corrupt project without a backup explains itself and changes nothing', async () => {
    seedProject();
    vi.mocked(openProjectApi).mockRejectedValue({
      code: 'ProjectCorrupt',
      message: 'truncated',
      details: null,
    });
    vi.mocked(projectBackupPath).mockResolvedValue(null);
    render(<ConfirmDialog />);
    const p = openProject('/docs/saved.photom');
    expect(await screen.findByText(/damaged or incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/original images are not affected/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await p;
    expect(useProjectStore.getState().images).toHaveLength(1); // current work untouched
  });

  it('does nothing when the file dialog is cancelled', async () => {
    vi.mocked(pickProject).mockResolvedValue(null);
    await openProject();
    expect(openProjectApi).not.toHaveBeenCalled();
  });
});

describe('dirty tracking', () => {
  it('marks dirty on image and persisted-state changes, not on view changes', () => {
    renderHook(() => useDirtyTracking());
    const dirty = () => useProjectStore.getState().dirty;
    expect(dirty()).toBe(false);

    seedProject(); // images added
    expect(dirty()).toBe(true);

    useProjectStore.getState().setDirty(false);
    useEditorStore.getState().setViewport('a', { zoom: 3, panX: 0, panY: 0 });
    useEditorStore.getState().setSplit('a', 0.2);
    expect(dirty()).toBe(false);

    useEditorStore.getState().setRefine('a', { feather: 9 });
    expect(dirty()).toBe(true);
  });

  it('opening a project does not make it dirty', async () => {
    renderHook(() => useDirtyTracking());
    vi.mocked(openProjectApi).mockResolvedValue(opened());
    await openProject('/docs/saved.photom');
    expect(useProjectStore.getState().dirty).toBe(false);
  });
});

describe('recovery dialog', () => {
  const entry = {
    id: 'p-1',
    name: 'My work',
    savedAt: '2026-10-05T10:00:00Z',
    originalPath: '/docs/my.photom',
    imageCount: 2,
  };

  it('offers each autosave and restores it as unsaved work tied to the original path', async () => {
    useUiStore.setState({ recovery: [entry] });
    vi.mocked(restoreRecovery).mockResolvedValue(
      opened({ meta: { ...opened().meta, path: '/docs/my.photom' } }),
    );
    render(<RecoveryDialog />);
    expect(await screen.findByText('Recover unsaved work?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(useProjectStore.getState().images).toHaveLength(2));
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().path).toBe('/docs/my.photom');
    expect(useUiStore.getState().recovery).toHaveLength(0);
  });

  it('Discard asks first, and only deletes the autosave when confirmed', async () => {
    useUiStore.setState({ recovery: [entry] });
    render(
      <>
        <RecoveryDialog />
        <ConfirmDialog />
      </>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
    expect(discardRecovery).not.toHaveBeenCalled();
    expect(useUiStore.getState().recovery).toHaveLength(1);

    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);
    const confirm = await screen.findByText('Discard recovered work?');
    const dialog = confirm.closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    expect(discardRecovery).toHaveBeenCalledWith('p-1');
    await waitFor(() => expect(useUiStore.getState().recovery).toHaveLength(0));
  });

  it('is not shown when there is nothing to recover', () => {
    render(<RecoveryDialog />);
    expect(screen.queryByText('Recover unsaved work?')).not.toBeInTheDocument();
  });
});

describe('title', () => {
  it('shows name.photom and an asterisk when dirty', () => {
    expect(projectTitle('Untitled', null, false)).toBe('Untitled.photom');
    expect(projectTitle('x', '/a/b/dog.photom', true)).toBe('dog.photom *');
    expect(projectTitle('x', 'C:\\Users\\me\\dog.photom', false)).toBe('dog.photom');
  });
});
