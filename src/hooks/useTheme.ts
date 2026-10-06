import { useEffect } from 'react';
import { useUiStore } from '@/stores/uiStore';

/** Applies the selected theme to <html data-theme>. "system" follows the OS preference. */
export function useApplyTheme() {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
