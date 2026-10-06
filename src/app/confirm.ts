import { useUiStore, type ConfirmButton } from '@/stores/uiStore';

export interface AskOptions {
  title: string;
  message: string;
  buttons: ConfirmButton[];
  cancelId: string;
}

/** Show the confirmation dialog and resolve with the id of the chosen button. */
export function ask(options: AskOptions): Promise<string> {
  return new Promise((resolve) => {
    useUiStore.getState().setConfirm({ ...options, resolve });
  });
}
