import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/models', () => ({
  installRecommended: vi.fn().mockResolvedValue(2),
}));
vi.mock('@/api/settings', () => ({
  updateSettings: vi.fn(async (s: unknown) => s),
}));

import * as api from '@/api/models';
import { updateSettings as saveSettings } from '@/api/settings';
import { ModelsWelcomeDialog } from '@/dialogs/ModelsWelcomeDialog';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { model, seedHub } from '@/test/hubFixtures';

describe('ModelsWelcomeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedHub([model('a', { sizeBytes: 60_000_000 }), model('b', { sizeBytes: 80_000_000 })]);
    useSettingsStore.setState({ loaded: true, modelsOnboardingDone: false });
    useUiStore.setState({ screen: 'home', settingsOpen: false, recovery: [], confirm: null });
    useProjectStore.setState({ images: [] });
  });

  it('offers the recommended models once, with the total size', () => {
    render(<ModelsWelcomeDialog />);
    expect(screen.getByRole('dialog', { name: 'Add the recommended models?' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Install recommended (about 140 MB)' }),
    ).toBeVisible();
  });

  it('installs and never shows again', async () => {
    render(<ModelsWelcomeDialog />);
    await userEvent.click(screen.getByRole('button', { name: /Install recommended/ }));
    expect(api.installRecommended).toHaveBeenCalled();
    expect(useSettingsStore.getState().modelsOnboardingDone).toBe(true);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ modelsOnboardingDone: true }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('skip answers without downloading anything', async () => {
    render(<ModelsWelcomeDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(api.installRecommended).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().modelsOnboardingDone).toBe(true);
  });

  it('Escape counts as skipping', async () => {
    render(<ModelsWelcomeDialog />);
    await userEvent.keyboard('{Escape}');
    expect(api.installRecommended).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().modelsOnboardingDone).toBe(true);
  });

  it.each([
    ['already answered', () => useSettingsStore.setState({ modelsOnboardingDone: true })],
    ['settings not loaded yet', () => useSettingsStore.setState({ loaded: false })],
    ['another dialog is open', () => useUiStore.setState({ settingsOpen: true })],
    ['a project is open', () => useUiStore.setState({ screen: 'edit' })],
    [
      'nothing can be downloaded',
      () => seedHub([model('a', { installable: false }), model('b', { recommended: false })]),
    ],
  ])('stays away when %s', (_why, arrange) => {
    arrange();
    render(<ModelsWelcomeDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
