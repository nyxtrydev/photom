import { invoke } from '@tauri-apps/api/core';
import { isAppError, type AppError } from '@/types/error';

/** Normalise anything thrown by `invoke` into a typed `AppError`. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return {
    code: 'Internal',
    message: err instanceof Error ? err.message : String(err),
    details: null,
  };
}

/** Typed wrapper around Tauri `invoke`; rejects with `AppError` only. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}

/** Binary IPC (raw bytes, no JSON/base64). */
export async function callBinary(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<ArrayBuffer>(command, args);
  } catch (err) {
    throw toAppError(err);
  }
}
