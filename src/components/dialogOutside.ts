/**
 * Pass to a Radix Dialog's `onInteractOutside`: clicking a toast must neither close the dialog
 * nor be swallowed by it (toasts can appear while a dialog is open, e.g. a failed update check).
 */
export function ignoreToastClicks(event: {
  target: EventTarget | null;
  preventDefault: () => void;
}) {
  if (event.target instanceof Element && event.target.closest('[data-notice-stack]')) {
    event.preventDefault();
  }
}
