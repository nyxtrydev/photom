import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportError } from '@/app/errors';
import { useUiStore } from '@/stores/uiStore';
import { NoticeStack } from './NoticeStack';

const notify = useUiStore.getState().notify;

beforeEach(() => {
  vi.useFakeTimers();
  useUiStore.setState({ notices: [], settingsOpen: false, settingsTab: 'general' });
});
afterEach(() => vi.useRealTimers());

describe('toasts', () => {
  it('success and info toasts disappear on their own', () => {
    render(<NoticeStack />);
    act(() => notify('success', 'Saved'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(6100));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('error toasts stay until dismissed so they cannot be missed', () => {
    render(<NoticeStack />);
    act(() => notify('error', 'Something failed'));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  it('warnings last longer than successes', () => {
    render(<NoticeStack />);
    act(() => notify('warning', 'Careful'));
    act(() => void vi.advanceTimersByTime(7000));
    expect(screen.getByText('Careful')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.queryByText('Careful')).not.toBeInTheDocument();
  });

  it('does not dismiss while the pointer is over it, then gives you a moment after you leave', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<NoticeStack />);
    act(() => notify('success', 'Hold on'));
    const toast = screen.getByText('Hold on').closest('[role]')!;
    await userEvent.hover(toast);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText('Hold on')).toBeInTheDocument();
    await userEvent.unhover(toast);
    act(() => void vi.advanceTimersByTime(6500));
    expect(screen.queryByText('Hold on')).not.toBeInTheDocument();
  });

  it('technical details are hidden behind "Show details"', async () => {
    vi.useRealTimers();
    render(<NoticeStack />);
    act(() => notify('error', 'Export failed.', 'os error 28: no space left'));
    const summary = screen.getByText('Show details');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText('os error 28: no space left')).toBeVisible();
  });

  it('uses alert for problems and status for good news (screen readers)', () => {
    render(<NoticeStack />);
    act(() => {
      notify('error', 'Bad');
      notify('success', 'Good');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Bad');
    expect(screen.getByRole('status')).toHaveTextContent('Good');
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('an action runs and closes the toast', async () => {
    vi.useRealTimers();
    const onClick = vi.fn();
    render(<NoticeStack />);
    act(() => notify('success', 'Exported', undefined, [{ label: 'Open folder', onClick }]));
    await userEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByText('Exported')).not.toBeInTheDocument();
  });
});

describe('reportError', () => {
  it('shows a friendly title with the technical message behind details', () => {
    reportError({ code: 'Io', message: 'I/O error: broken pipe', details: null });
    const n = useUiStore.getState().notices[0]!;
    expect(n).toMatchObject({ kind: 'error', message: 'A file could not be read or written.' });
    expect(n.details).toContain('broken pipe');
  });

  it('a missing model offers a way to fix it, and the action opens Settings > Model', () => {
    reportError({ code: 'ModelMissing', message: 'isnet not found', details: null });
    const n = useUiStore.getState().notices[0]!;
    expect(n.details).toContain('Photom works offline');
    expect(n.actions?.[0]?.label).toBe('Open model settings');
    n.actions![0]!.onClick();
    expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'model' });
  });

  it('out-of-memory suggests a smaller image or a higher limit', () => {
    reportError({ code: 'OutOfMemory', message: '120 MP above the limit', details: null });
    const n = useUiStore.getState().notices[0]!;
    expect(n.details).toContain('smaller image');
    n.actions![0]!.onClick();
    expect(useUiStore.getState().settingsTab).toBe('general');
  });

  it('unknown thrown values still produce a usable notice', () => {
    reportError(new Error('boom'));
    expect(useUiStore.getState().notices[0]).toMatchObject({
      kind: 'error',
      message: 'Something went wrong.',
    });
    reportError('just a string');
    expect(useUiStore.getState().notices).toHaveLength(2);
  });
});
