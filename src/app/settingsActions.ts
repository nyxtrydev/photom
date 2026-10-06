import { getSettings, updateSettings as updateSettingsApi } from '@/api/settings';
import { currentSettings, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import type { Settings, ThemeMode } from '@/types/dto';
import { reportError } from './errors';

/** Load persisted settings and apply them (theme included). */
export async function loadSettings() {
  try {
    const s = await getSettings();
    useSettingsStore.getState().apply(s);
    useUiStore.getState().setTheme(s.theme);
  } catch (e) {
    reportError(e);
  }
}

/** Merge a patch into the settings, persist it, and adopt the backend's validated copy. */
export async function updateSettings(patch: Partial<Settings>) {
  const optimistic = { ...currentSettings(), ...patch };
  useSettingsStore.getState().apply(optimistic);
  try {
    useSettingsStore.getState().apply(await updateSettingsApi(optimistic));
  } catch (e) {
    reportError(e);
  }
}

export function changeTheme(theme: ThemeMode) {
  useUiStore.getState().setTheme(theme);
  void updateSettings({ theme });
}
