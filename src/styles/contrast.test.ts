import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** WCAG 2.x contrast ratio between two #rrggbb colours. */
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** Token values for a theme block (`:root` for light, `:root[data-theme='dark']` for dark). */
function tokens(selector: RegExp): Record<string, string> {
  const m = css.match(selector);
  if (!m) throw new Error(`no block for ${selector}`);
  const out: Record<string, string> = {};
  for (const [, name, value] of m[1]!.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
    out[name!] = value!;
  return out;
}

const themes = {
  light: { t: tokens(/:root,\s*:root\[data-theme='light'\]\s*\{([^}]*)\}/s), name: 'light' },
  dark: { t: tokens(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/s), name: 'dark' },
};

/** [foreground, background, minimum ratio, what it is used for]. 4.5 = normal text, 3 = large text / UI. */
const pairs: [string, string, number, string][] = [
  ['text', 'bg-app', 4.5, 'body text on the window'],
  ['text', 'bg-surface', 4.5, 'body text on cards and dialogs'],
  ['text', 'bg-muted', 4.5, 'text in inputs and secondary buttons'],
  ['text-muted', 'bg-app', 4.5, 'hints on the window'],
  ['text-muted', 'bg-surface', 4.5, 'hints on cards'],
  ['text-muted', 'bg-muted', 4.5, 'hints on inputs'],
  ['primary-contrast', 'primary', 4.5, 'label on a primary button'],
  ['primary-contrast', 'primary-hover', 4.5, 'label on a hovered primary button'],
  ['primary', 'bg-surface', 4.5, 'primary-coloured text/links on cards'],
  ['primary', 'bg-app', 4.5, 'primary-coloured text on the window'],
  ['primary', 'bg-muted', 4.5, 'primary text on muted backgrounds (active tool, chips)'],
  ['success-fg', 'bg-surface', 4.5, 'success text ("Done")'],
  ['success-fg', 'bg-app', 4.5, 'success text on the window'],
  ['success', 'bg-app', 3, 'status dot / graphics'],
  ['danger', 'bg-surface', 4.5, 'error text'],
  ['danger', 'bg-app', 4.5, 'error text on the window'],
  ['focus-ring', 'bg-app', 3, 'keyboard focus ring'],
  ['focus-ring', 'bg-surface', 3, 'keyboard focus ring on cards'],
  ['focus-ring', 'bg-muted', 3, 'keyboard focus ring on inputs'],
];

describe.each(Object.values(themes))('WCAG AA contrast ($name theme)', ({ t }) => {
  it.each(pairs)('%s on %s is at least %s:1 (%s)', (fg, bg, min) => {
    const ratio = contrast(t[fg]!, t[bg]!);
    expect(t[fg], `missing token ${fg}`).toBeDefined();
    expect(ratio, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      min,
    );
  });
});

describe('contrast helper', () => {
  it('matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});
