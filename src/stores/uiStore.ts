import { create } from 'zustand';
import type { RecoveryEntry, ThemeMode } from '@/types/dto';

export type { ThemeMode };
export type Screen = 'home' | 'removeBackground' | 'batch' | 'edit' | 'history';
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  message: string;
  details?: string;
  actions?: NoticeAction[];
}

const THEME_KEY = 'photom.theme';

// TODO(phase-3): move theme persistence to the Tauri store (settingsStore).
function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

export interface ConfirmButton {
  id: string;
  label: string;
  /** Visual emphasis. */
  tone?: 'primary' | 'danger' | 'default';
}

export interface ConfirmRequest {
  title: string;
  message: string;
  buttons: ConfirmButton[];
  /** Button id returned when the dialog is dismissed (Esc / click outside). */
  cancelId: string;
  resolve: (id: string) => void;
}

let noticeSeq = 0;

interface UiState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  confirm: ConfirmRequest | null;
  setConfirm: (c: ConfirmRequest | null) => void;
  recovery: RecoveryEntry[];
  setRecovery: (r: RecoveryEntry[]) => void;
  lastAutosave: string | null;
  setLastAutosave: (t: string | null) => void;
  /** Export dialog: closed (null) or open with an optional starting scope/preset. */
  exportDialog: { scope?: 'current' | 'all'; presetId?: string } | null;
  setExportDialog: (d: { scope?: 'current' | 'all'; presetId?: string } | null) => void;
  settingsOpen: boolean;
  settingsTab: string;
  setSettingsOpen: (open: boolean) => void;
  /** Open Settings, optionally on a specific tab (general, model, export, shortcuts, about). */
  openSettings: (tab?: string) => void;
  setSettingsTab: (tab: string) => void;
  screen: Screen;
  setScreen: (screen: Screen) => void;
  /** TODO(phase-5): replace with the full toast system. */
  notices: Notice[];
  notify: (kind: NoticeKind, message: string, details?: string, actions?: NoticeAction[]) => void;
  dismissNotice: (id: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: loadTheme(),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    set({ theme });
  },
  confirm: null,
  setConfirm: (confirm) => set({ confirm }),
  recovery: [],
  setRecovery: (recovery) => set({ recovery }),
  lastAutosave: null,
  setLastAutosave: (lastAutosave) => set({ lastAutosave }),
  exportDialog: null,
  setExportDialog: (exportDialog) => set({ exportDialog }),
  settingsOpen: false,
  settingsTab: 'general',
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  screen: 'home',
  setScreen: (screen) => set({ screen }),
  notices: [],
  notify: (kind, message, details, actions) =>
    set((s) => ({
      notices: [...s.notices, { id: ++noticeSeq, kind, message, details, actions }],
    })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
