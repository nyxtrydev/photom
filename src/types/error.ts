/** Mirrors `models/error.rs`. Keep in sync. */
export type AppErrorCode =
  | 'Io'
  | 'Decode'
  | 'UnsupportedFormat'
  | 'ModelMissing'
  | 'ModelLoad'
  | 'Inference'
  | 'OutOfMemory'
  | 'ProjectCorrupt'
  | 'ExportFailed'
  | 'Cancelled'
  | 'Permission'
  | 'InvalidInput'
  | 'Internal';

export interface AppError {
  code: AppErrorCode;
  message: string;
  details?: string | null;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppError).code === 'string' &&
    typeof (value as AppError).message === 'string'
  );
}
