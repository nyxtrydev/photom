import { create } from 'zustand';
import type { RecentProject, Settings } from '@/types/dto';

/** Client-side defaults, used until the backend answers (and in tests). Mirrors `Settings::default()`. */
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  theme: 'system',
  autosaveSeconds: 60,
  recentProjectsLimit: 10,
  defaultExportFolder: null,
  modelType: 'fast',
  processing: 'cpu',
  shortcuts: {},
  exportPresets: [],
  shadowPresets: [],
  defaultPreset: null,
  lastUsedFolders: {},
  undoDepth: 50,
  pixelLimitMp: 100,
  upscaleMaxMp: 100,
  embedOriginals: true,
  exportConcurrency: 1,
  recentProjects: [],
  modelsOnboardingDone: false,
  modelsCatalogUrl: null,
  modelsExtraHost: null,
};

interface SettingsState extends Settings {
  loaded: boolean;
  /** Replace with the backend's validated copy. */
  apply: (s: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  apply: (s) => set({ ...s, loaded: true }),
}));

/** The plain Settings object (without store-only fields) for sending to the backend. */
export function currentSettings(): Settings {
  const { loaded: _l, apply: _a, ...rest } = useSettingsStore.getState();
  void _l;
  void _a;
  return rest;
}

export const selectRecent = (s: SettingsState): RecentProject[] => s.recentProjects;
