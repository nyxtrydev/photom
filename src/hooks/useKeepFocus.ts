import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps keyboard focus inside a container whose buttons are swapped for others when its state
 * changes (Install now -> Pause). Without this the focused button is removed and focus falls to
 * the page body, so a keyboard user loses their place.
 *
 * Focus only moves when it was inside the container and has been lost; clicking elsewhere on
 * purpose is respected.
 */
export function useKeepFocus(ref: RefObject<HTMLElement | null>, stateKey: string) {
  const inside = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const enter = () => {
      inside.current = true;
    };
    // A pointer press anywhere else is a deliberate move away.
    const away = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) inside.current = false;
    };
    // Tabbing out to another element is deliberate too (relatedTarget is null when the focused
    // element was removed, which must not count).
    const leave = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !el.contains(next)) inside.current = false;
    };
    el.addEventListener('focusin', enter);
    el.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', away, true);
    return () => {
      el.removeEventListener('focusin', enter);
      el.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !inside.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && el.contains(active)) return;
    el.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, [stateKey, ref]);
}
