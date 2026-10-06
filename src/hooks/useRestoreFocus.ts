import { useEffect, useRef } from 'react';

/**
 * Give keyboard focus back to whatever had it before a dialog opened.
 * Radix only does this for dialogs opened through its own Trigger; ours open from app state.
 */
export function useRestoreFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const el = opener.current;
    opener.current = null;
    if (el && el.isConnected && el !== document.body) {
      // After Radix has finished unmounting and releasing its focus trap.
      const id = requestAnimationFrame(() => el.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);
}
