import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/models', () => ({
  installModels: vi.fn().mockResolvedValue(1),
  pauseModel: vi.fn().mockResolvedValue(undefined),
  resumeModel: vi.fn().mockResolvedValue(undefined),
  cancelModel: vi.fn().mockResolvedValue(undefined),
}));

import * as api from '@/api/models';
import { ModelGate, ModelInstallBanner } from '@/components/ModelInstallBanner';
import { useHubStore } from '@/stores/hubStore';
import { useUiStore } from '@/stores/uiStore';
import { model, seedHub, withState } from '@/test/hubFixtures';

const req = { feature: 'text-removal' };
const two = () => [
  model('text-detector', { sizeBytes: 60_000_000 }),
  model('inpaint-lama', { sizeBytes: 80_000_000 }),
];

describe('ModelInstallBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ settingsOpen: false, settingsTab: 'general' });
  });

  it('offers a one-click install with the combined size', async () => {
    seedHub(two());
    render(<ModelInstallBanner requirement={req} />);
    expect(screen.getByText(/Text Removal needs 2 models \(about 140 MB total\)/)).toBeVisible();
    expect(screen.getByText('Works offline after install.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Install now' }));
    expect(api.installModels).toHaveBeenCalledWith(['text-detector', 'inpaint-lama']);
  });

  it('renders nothing visible once everything is installed', () => {
    seedHub(two().map((m) => ({ ...m, state: withState('installed') })));
    render(<ModelInstallBanner requirement={req} />);
    expect(screen.queryByTestId('model-install-banner')).toBeNull();
  });

  it('opens the Models page from Details', async () => {
    seedHub(two());
    render(<ModelInstallBanner requirement={req} />);
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe('models');
  });

  it('shows size, speed and time left while downloading, with pause and cancel', async () => {
    seedHub([model('text-detector', { sizeBytes: 140_000_000, state: withState('downloading') })]);
    act(() =>
      useHubStore.getState().setProgress({
        id: 'text-detector',
        downloadedBytes: 42_000_000,
        totalBytes: 140_000_000,
        speedBps: 6_200_000,
        etaSeconds: 16,
      }),
    );
    render(<ModelInstallBanner requirement={{ models: ['text-detector'] }} label="Text Removal" />);
    expect(screen.getByText('42 MB of 140 MB, 6.2 MB/s, about 16 s left')).toBeVisible();
    const bar = screen.getByRole('progressbar', { name: /Text Removal/ });
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(api.pauseModel).toHaveBeenCalledWith('text-detector');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelModel).toHaveBeenCalledWith('text-detector');
  });

  it('keeps keyboard focus in the banner as its buttons change', async () => {
    seedHub([model('a', { sizeBytes: 100 })]);
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    const install = screen.getByRole('button', { name: 'Install now' });
    install.focus();
    expect(install).toHaveFocus();
    act(() => useHubStore.getState().setState('a', withState('downloading')));
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveFocus();
    act(() => useHubStore.getState().setState('a', withState('paused')));
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveFocus();
  });

  it('lets a queued model be paused', async () => {
    seedHub([model('a', { state: withState('queued') })]);
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(api.pauseModel).toHaveBeenCalledWith('a');
  });

  it('shows the paused position and resumes', async () => {
    seedHub([model('a', { sizeBytes: 100_000_000, state: withState('paused') })]);
    act(() =>
      useHubStore.getState().setProgress({
        id: 'a',
        downloadedBytes: 42_000_000,
        totalBytes: 100_000_000,
        speedBps: 0,
        etaSeconds: null,
      }),
    );
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    expect(screen.getByText('Paused at 42 MB')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(api.resumeModel).toHaveBeenCalledWith('a');
  });

  it.each([
    ['verifying', 'Verifying the download...'],
    ['installing', 'Installing...'],
    ['queued', 'Thing: waiting to start...'],
  ] as const)('shows the %s stage without a percentage', (kind, text) => {
    seedHub([model('a', { state: withState(kind) })]);
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it.each([
    ['Network', /offline or the download server cannot be reached/],
    ['DiskFull', /not enough free disk space/],
    ['HashMismatch', /corrupted and has been discarded/],
  ])('explains a %s failure and offers a retry', async (code, text) => {
    seedHub([model('a', { state: { kind: 'failed', code, message: 'needs 140 MB' } })]);
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    expect(screen.getByText('Thing could not be installed')).toBeVisible();
    expect(screen.getByText(text)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(api.installModels).toHaveBeenCalledWith(['a']);
  });

  it('says so when a model is not published yet and offers no install button', () => {
    seedHub([model('a', { installable: false })]);
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    expect(screen.getByText('This download is not available yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install now' })).toBeNull();
  });

  it('does not claim anything is missing before the model list has loaded', () => {
    useHubStore.setState({ models: {}, order: [], loaded: false });
    render(<ModelInstallBanner requirement={req} />);
    expect(screen.queryByTestId('model-install-banner')).toBeNull();
  });

  it('announces progress to screen readers in 10% steps', () => {
    seedHub([model('a', { sizeBytes: 100, state: withState('downloading') })]);
    render(<ModelInstallBanner requirement={{ models: ['a'] }} label="Thing" />);
    const progress = (n: number) =>
      act(() =>
        useHubStore.getState().setProgress({
          id: 'a',
          downloadedBytes: n,
          totalBytes: 100,
          speedBps: 1,
          etaSeconds: 1,
        }),
      );
    progress(23);
    expect(screen.getByRole('status')).toHaveTextContent('Thing: 20% downloaded');
    progress(27);
    expect(screen.getByRole('status')).toHaveTextContent('Thing: 20% downloaded');
    progress(61);
    expect(screen.getByRole('status')).toHaveTextContent('Thing: 60% downloaded');
  });
});

describe('ModelGate', () => {
  it('disables its controls with an explanation until the models are installed', () => {
    seedHub(two());
    const { container } = render(
      <ModelGate requirement={req}>
        <button type="button">Remove</button>
      </ModelGate>,
    );
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(container.querySelector('fieldset')).toHaveAttribute(
      'title',
      'Text Removal unlocks when its model is installed.',
    );
  });

  it('unlocks without a restart when the install finishes', () => {
    seedHub(two());
    render(
      <ModelGate requirement={req}>
        <button type="button">Remove</button>
      </ModelGate>,
    );
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    act(() => {
      useHubStore.getState().setState('text-detector', withState('installed'));
      useHubStore.getState().setState('inpaint-lama', withState('installed'));
    });
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
