import { open, save } from '@tauri-apps/plugin-dialog';
import { SUPPORTED_EXTENSIONS } from '@/utils/formats';

export async function pickImages(): Promise<string[]> {
  const res = await open({
    multiple: true,
    filters: [{ name: 'Images', extensions: [...SUPPORTED_EXTENSIONS] }],
  });
  return res ?? [];
}

export async function pickFolder(): Promise<string | null> {
  const res = await open({ directory: true });
  return res ?? null;
}

export async function pickBackgroundImage(): Promise<string | null> {
  const res = await open({
    multiple: false,
    filters: [{ name: 'Images', extensions: [...SUPPORTED_EXTENSIONS] }],
  });
  return typeof res === 'string' ? res : null;
}

const PROJECT_FILTER = [{ name: 'Photom project', extensions: ['photom'] }];

export async function pickProject(): Promise<string | null> {
  const res = await open({ multiple: false, filters: PROJECT_FILTER });
  return typeof res === 'string' ? res : null;
}

export async function pickProjectSavePath(defaultName: string): Promise<string | null> {
  return save({ filters: PROJECT_FILTER, defaultPath: defaultName });
}

export async function pickModelFile(): Promise<string | null> {
  const res = await open({
    multiple: false,
    filters: [{ name: 'ONNX model', extensions: ['onnx'] }],
  });
  return typeof res === 'string' ? res : null;
}

export async function pickExportFolder(): Promise<string | null> {
  const res = await open({ directory: true });
  return typeof res === 'string' ? res : null;
}
