# @alayrasystems/nexus-ui-tokens

The design tokens every Alayra Nexus surface shares: the open-source dashboard, the hosted
portal, the website and the admin console. Direction A, "Signal Cyan": the logo's cyan on deep
ink navy, gold only for plan tiers and highlights, Geist and Geist Mono.

| File | What it is |
|---|---|
| `src/tokens.ts` | The source of truth: colours for both themes, shared shape/type/motion tokens, and the contrast pairs CI enforces. |
| `src/contrast.ts` | The WCAG 2.x contrast-ratio formula. |
| `src/css.ts` | Renders the tokens as CSS custom properties. |
| `tokens.css` | Generated. Never edit by hand. |

## Using it

Import `tokens.css` once, before any component styles. Dark is the default; set
`<html data-theme="light">` for the light palette. Load the fonts yourself (self-hosted:
`@fontsource-variable/geist` and `@fontsource-variable/geist-mono`).

Two cyans, on purpose:

- `--primary` / `--on-primary`: the bright fill behind button text, with dark text on it.
- `--accent` / `--accent-contrast`: the readable cyan for links, text, focus rings, toggles and
  progress. In light mode it is a deep teal, because bright cyan on white is 1.8:1.

## Changing a value

1. Edit `src/tokens.ts`.
2. Run `npm run tokens:build` from the repository root, which rewrites this package's
   `tokens.css` and the dashboard's copy.
3. Run `npm run check:tokens`. It fails if any declared pair misses its WCAG minimum (4.5:1 for
   text, 3:1 for focus rings and other marks), or if a colour literal appears anywhere in
   `web/src` outside `tokens.css`.

The package is not published to npm yet; it is versioned with the gateway and released with
`@alayrasystems/nexus-core`.
