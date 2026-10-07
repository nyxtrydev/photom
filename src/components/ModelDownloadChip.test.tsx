import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ModelDownloadChip } from '@/components/ModelDownloadChip';
import { useHubStore } from '@/stores/hubStore';
import { useUiStore } from '@/stores/uiStore';
import { model, seedHub, withState } from '@/test/hubFixtures';

describe('ModelDownloadChip', () => {
  beforeEach(() => useUiStore.setState({ settingsOpen: false, settingsTab: 'general' }));

  it('renders nothing when no download is running', () => {
    seedHub([model('a'), model('b', { state: withState('installed') })]);
    const { container } = render(<ModelDownloadChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the active download with its percentage and opens the Models page', async () => {
    seedHub([model('upscale', { name: 'Upscaler', state: withState('downloading') })]);
    render(<ModelDownloadChip />);
    expect(screen.getByRole('button', { name: 'Downloading Upscaler' })).toBeVisible();
    act(() =>
      useHubStore.getState().setProgress({
        id: 'upscale',
        downloadedBytes: 62,
        totalBytes: 100,
        speedBps: 1,
        etaSeconds: 1,
      }),
    );
    const chip = screen.getByRole('button', { name: 'Downloading Upscaler 62%' });
    await userEvent.click(chip);
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe('models');
  });

  it('prefers the model that is actually downloading and counts the others', () => {
    seedHub([
      model('q', { name: 'Waiting', state: withState('queued') }),
      model('d', { name: 'Busy', state: withState('downloading') }),
      model('p', { name: 'Held', state: withState('paused') }),
    ]);
    render(<ModelDownloadChip />);
    expect(screen.getByRole('button')).toHaveTextContent('Downloading Busy');
    expect(screen.getByRole('button')).toHaveTextContent('+2 more');
  });

  it('says so when the only download is paused', () => {
    seedHub([model('p', { name: 'Held', state: withState('paused') })]);
    render(<ModelDownloadChip />);
    expect(screen.getByRole('button')).toHaveTextContent('Held paused');
  });
});
