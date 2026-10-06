import type { Config } from 'tailwindcss';

const v = (name: string) => `var(--${name})`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        app: v('bg-app'),
        surface: v('bg-surface'),
        muted: v('bg-muted'),
        border: v('border'),
        primary: {
          DEFAULT: v('primary'),
          hover: v('primary-hover'),
          contrast: v('primary-contrast'),
        },
        fg: { DEFAULT: v('text'), muted: v('text-muted') },
        success: { DEFAULT: v('success'), fg: v('success-fg') },
        danger: v('danger'),
      },
      borderRadius: { sm: v('radius-sm'), md: v('radius-md'), lg: v('radius-lg') },
      boxShadow: { card: v('shadow-card') },
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
        display: ['"Fraunces Variable"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
