import type { OpenedProject, ProjectMeta, ProjectPayload, RecoveryEntry } from '@/types/dto';
import { call } from './invoke';

export const saveProject = (payload: ProjectPayload, path: string) =>
  call<ProjectMeta>('save_project', { payload, path });

export const openProject = (path: string) => call<OpenedProject>('open_project', { path });

export const projectBackupPath = (path: string) =>
  call<string | null>('project_backup_path', { path });

export const resetSession = () => call<void>('reset_session');

export const autosaveProject = (payload: ProjectPayload) =>
  call<string>('autosave_project', { payload });

export const listRecovery = () => call<RecoveryEntry[]>('list_recovery');
export const restoreRecovery = (id: string) => call<OpenedProject>('restore_recovery', { id });
export const discardRecovery = (id: string) => call<void>('discard_recovery', { id });
