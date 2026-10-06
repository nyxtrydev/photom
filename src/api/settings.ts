import type { AppInfo, ModelKind, Settings } from '@/types/dto';
import { call } from './invoke';

export const getSettings = () => call<Settings>('get_settings');
export const updateSettings = (settings: Settings) =>
  call<Settings>('update_settings', { settings });
export const removeRecentProject = (path: string) =>
  call<Settings>('remove_recent_project', { path });
export const clearRecentProjects = () => call<Settings>('clear_recent_projects');
export const getAppInfo = () => call<AppInfo>('get_app_info');
export const openLogsFolder = () => call<void>('open_logs_folder');
export const revealPath = (path: string) => call<void>('reveal_path', { path });
export const importModel = (kind: ModelKind, path: string) =>
  call<void>('import_model', { kind, path });
export const readLicences = () => call<string>('read_licences');
export const pathsExist = (paths: string[]) => call<boolean[]>('paths_exist', { paths });
