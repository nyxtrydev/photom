# Design tokens

Source: `src/styles/tokens.css`, mapped to Tailwind in `tailwind.config.ts`. Light values come from the mockups in `docs/design/`; Dark is derived.
Includes `--checker-a/-b` and `--focus-ring` in addition to the spec tokens. Use `.checkerboard` for transparency backgrounds.

## Contrast (WCAG AA)

`src/styles/contrast.test.ts` checks every foreground/background pair below in **both** themes (4.5:1 for text, 3:1 for graphics and focus rings): `text`, `text-muted` and `primary` on `bg-app` / `bg-surface` / `bg-muted`, `primary-contrast` on `primary` and `primary-hover`, `success-fg` and `danger` on surfaces, `success` as a status dot, and `focus-ring`.

- `--success` is for dots/graphics; use `--success-fg` (`text-success-fg`) for success **text**.
- Dark `--primary` is `#dd7d44` (lightened from the first draft so primary text passes on muted backgrounds).
- `--text-muted` in Light is `#7a6757` (the mockup's `#8a7767` was too light for AA).
