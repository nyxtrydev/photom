import { toAppError } from '@/api/invoke';
import { strings } from '@/i18n/strings';
import { useUiStore, type NoticeAction } from '@/stores/uiStore';
import type { AppError } from '@/types/error';

/** Next step to offer for an error, in plain language. */
function actionsFor(err: AppError): NoticeAction[] {
  const ui = useUiStore.getState();
  switch (err.code) {
    case 'ModelMissing':
    case 'ModelLoad':
      return [
        { label: strings.errorActions.modelSettings, onClick: () => ui.openSettings('model') },
      ];
    case 'OutOfMemory':
      return [
        { label: strings.errorActions.generalSettings, onClick: () => ui.openSettings('general') },
      ];
    default:
      return [];
  }
}

/**
 * Show a friendly toast for any failure (with the technical message behind "Show details") and
 * return the typed error. Use this instead of formatting errors by hand.
 */
export function reportError(e: unknown): AppError {
  const err = toAppError(e);
  const hint = strings.errorHints[err.code as keyof typeof strings.errorHints];
  const details = [hint, err.message].filter(Boolean).join('\n');
  useUiStore.getState().notify('error', strings.errors[err.code], details, actionsFor(err));
  return err;
}
