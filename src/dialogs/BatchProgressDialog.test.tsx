import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/export', () => ({
  exportPng: vi.fn().mockResolvedValue('job-2'),
  removeBackgroundBatch: vi.fn().mockResolvedValue('job-3'),
  getJob: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue(undefined),
  pauseJob: vi.fn().mockResolvedValue(undefined),
  resumeJob: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn(),
  listHistory: vi.fn(),
  deleteHistoryItem: vi.fn(),
  clearHistory: vi.fn(),
  saveExportPreset: vi.fn(),
  deleteExportPreset: vi.fn(),
}));
vi.mock('@/api/settings', () => ({
  revealPath: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getAppInfo: vi.fn(),
  importModel: vi.fn(),
  openLogsFolder: vi.fn(),
  removeRecentProject: vi.fn(),
  clearRecentProjects: vi.fn(),
  pathsExist: vi.fn(),
}));

import { cancelJob, exportPng, getJob, pauseJob, resumeJob } from '@/api/export';
import { useProjectStore } from '@/stores/projectStore';
import { useQueueStore } from '@/stores/queueStore';
import type { JobItem, JobSnapshot } from '@/types/export';
import { BatchProgressDialog } from './BatchProgressDialog';

const item = (id: string, status: JobItem['status'], error?: string): JobItem => ({
  id,
  label: `${id}.png`,
  status,
  error: error ? { code: 'ExportFailed', message: error } : null,
  result: null,
});

function show(snap: Partial<JobSnapshot> & { items: JobItem[] }, request = true) {
  const full: JobSnapshot = {
    jobId: 'job-1',
    kind: 'export',
    status: 'running',
    done: snap.items.filter((i) => i.status === 'done' || i.status === 'failed').length,
    total: snap.items.length,
    ...snap,
  };
  useQueueStore.setState({
    jobs: { 'job-1': full },
    dialogJobId: 'job-1',
    requests: request
      ? {
          'job-1': {
            kind: full.kind,
            items: full.items.map((i) => ({ id: i.id, state: {} })),
            options: {
              background: 'transparent',
              size: { mode: 'original', width: 0, height: 0, maxSide: null },
              crop: { enabled: false, padding: 0 },
              compression: 6,
              filenameTemplate: 'x',
              folder: '/o',
            },
          },
        }
      : {},
    reported: { 'job-1': true },
  });
  return render(<BatchProgressDialog />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useQueueStore.setState({ jobs: {}, requests: {}, dialogJobId: null, reported: {} });
  useProjectStore.getState().load({ name: 'p', path: null, images: [], masks: {}, dirty: false });
  vi.mocked(getJob).mockResolvedValue({
    jobId: 'job-1',
    kind: 'export',
    status: 'running',
    done: 0,
    total: 0,
    items: [],
  });
});

describe('Batch progress dialog', () => {
  it('shows percentage, "N of M complete" and a status chip per item', async () => {
    show({
      items: [
        item('a', 'done'),
        item('b', 'processing'),
        item('c', 'queued'),
        item('d', 'failed', 'No cut-out'),
      ],
    });
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
    // Shown visibly and also announced via the dialog description.
    expect(screen.getAllByText('2 of 4 complete').length).toBeGreaterThanOrEqual(1);
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Done')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Processing...')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Queued')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Failed')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('No cut-out')).toBeInTheDocument(); // reason is visible
  });

  it('while running: Pause and Cancel are offered, Close is "Hide"', async () => {
    show({ items: [item('a', 'processing'), item('b', 'queued')] });
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(pauseJob).toHaveBeenCalledWith('job-1');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelJob).toHaveBeenCalledWith('job-1');
    expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
  });

  it('while paused the button becomes Resume and the state is announced', async () => {
    show({ status: 'paused', items: [item('a', 'done'), item('b', 'queued')] });
    expect(await screen.findByText(/Paused/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resumeJob).toHaveBeenCalledWith('job-1');
  });

  it('when finished shows a summary and only Close (no Pause/Cancel)', async () => {
    show({ status: 'done', items: [item('a', 'done'), item('b', 'done')] });
    expect(await screen.findByRole('status')).toHaveTextContent('All 2 images finished.');
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry failed' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useQueueStore.getState().dialogJobId).toBeNull();
  });

  it('a finished batch with failures summarises them and offers Retry', async () => {
    show({ status: 'done', items: [item('a', 'done'), item('b', 'failed', 'Disk full')] });
    expect(await screen.findByRole('status')).toHaveTextContent('1 finished, 1 failed.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    // Only the failed item is sent again, as a new job that takes over the dialog.
    expect(vi.mocked(exportPng).mock.calls[0]![0].map((i) => i.id)).toEqual(['b']);
    expect(useQueueStore.getState().dialogJobId).toBe('job-2');
  });

  it('a cancelled batch says how far it got', async () => {
    show({
      status: 'cancelled',
      items: [item('a', 'done'), item('b', 'cancelled'), item('c', 'cancelled')],
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Cancelled. 1 of 3 were finished.');
  });

  it('uses the right title for background removal jobs', async () => {
    show({ kind: 'removeBackground', items: [item('a', 'queued')] });
    expect(await screen.findByText('Removing backgrounds')).toBeInTheDocument();
  });

  it('renders nothing when no job is selected', () => {
    render(<BatchProgressDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('copes with an empty batch (0 of 0)', async () => {
    show({ status: 'done', items: [] });
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
