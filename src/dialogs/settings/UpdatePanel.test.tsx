import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/updates', () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn().mockResolvedValue(undefined),
  onUpdateProgress: vi.fn(),
}));

import { checkForUpdate, installUpdate, restartApp } from '@/api/updates';
import { useUiStore } from '@/stores/uiStore';
import { UpdatePanel } from './UpdatePanel';

const info = (over = {}) => ({
  available: true,
  currentVersion: '0.1.0',
  version: '0.2.0',
  notes: 'Faster exports.',
  date: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ notices: [] });
});

describe('Update panel (opt-in)', () => {
  it('does not contact the update server until the user asks', () => {
    render(<UpdatePanel />);
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  });

  it('says so when there is nothing newer', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(
      info({ available: false, version: null, notes: null }),
    );
    render(<UpdatePanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('You are up to date (version 0.1.0).')).toBeInTheDocument();
  });

  it('shows the new version and its notes, and lets you decline', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(info());
    render(<UpdatePanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Version 0.2.0 is available.')).toBeInTheDocument();
    expect(screen.getByText('Faster exports.')).toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled(); // never installs without a second explicit click
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument();
  });

  it('downloads, then offers to restart', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(info());
    let finish!: () => void;
    vi.mocked(installUpdate).mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<UpdatePanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Download and install' }));
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    finish();
    expect(await screen.findByText('Version 0.2.0 is installed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart Photom' }));
    expect(restartApp).toHaveBeenCalledOnce();
  });

  it('a failed check shows a plain-language error and lets you try again', async () => {
    vi.mocked(checkForUpdate).mockRejectedValue({
      code: 'Io',
      message: 'Could not reach the update server.',
      details: null,
    });
    render(<UpdatePanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await screen.findByRole('button', { name: 'Check for updates' });
    const n = useUiStore.getState().notices[0]!;
    expect(n.kind).toBe('error');
    expect(n.details).toContain('Could not reach the update server');
  });

  it('a failed install returns to the "available" state so it can be retried', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(info());
    vi.mocked(installUpdate).mockRejectedValue({
      code: 'Io',
      message: 'signature mismatch',
      details: null,
    });
    render(<UpdatePanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Download and install' }));
    expect(await screen.findByRole('button', { name: 'Download and install' })).toBeInTheDocument();
    expect(useUiStore.getState().notices[0]!.kind).toBe('error');
  });
});
