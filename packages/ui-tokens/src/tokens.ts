/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

// ── Alayra Nexus design tokens: Direction A, "Signal Cyan" ─────────────────────────────────────
//
// The one place a Nexus colour, font or size is decided. Every surface (the open-source
// dashboard, the hosted portal, the website, the admin console) reads these values; nothing
// else may write a colour literal. `tokens.css` is generated from this file by
// `npm run tokens:build`, and CI fails if it is stale or if any pair below misses its contrast.
//
// The logo's cyan is the brand colour, on deep ink navy. Gold is rare: plan tiers and highlights.
// Two cyans exist on purpose. `primary` is the bright fill behind button text (dark text on it).
// `accent` is the readable cyan for links, text, focus rings and small state marks (toggles,
// progress): in light mode it is a deep teal, because bright cyan on white is 1.8:1.

export type ThemeName = 'dark' | 'light';

/** Colour tokens, keyed by CSS variable name without the leading `--`. */
export type ThemeColors = Record<string, string>;

const darkColors: ThemeColors = {
  // Ground and glass: cards float as translucent glass over the ink background.
  'bg':            '#071019',
  'bg-accent':     '#0b1824',
  'surface':       'rgba(255, 255, 255, 0.035)',
  'surface-2':     'rgba(255, 255, 255, 0.06)',
  'surface-solid': '#0b1622',
  'border':        'rgba(255, 255, 255, 0.08)',
  'border-strong': 'rgba(255, 255, 255, 0.14)',
  // Text.
  'text':          '#f4f8fa',
  'muted':         '#9baab8',
  'subtle':        '#71818f',
  // Readable cyan: links, focus, selected states, small marks.
  'accent':          '#5df0ee',
  'accent-strong':   '#9af7f5',
  'accent-contrast': '#06242a',
  'accent-bg':       'rgba(93, 240, 238, 0.14)',
  // Bright cyan fill behind button text.
  'primary':         '#5df0ee',
  'primary-strong':  '#9af7f5',
  'on-primary':      '#06242a',
  // Gold: plan tiers and highlights only.
  'gold':    '#d9b477', 'gold-bg':   'rgba(217, 180, 119, 0.14)',
  // Status.
  'green':  '#4fd1a5', 'green-bg':  'rgba(79, 209, 165, 0.14)',
  'yellow': '#f2b84b', 'yellow-bg': 'rgba(242, 184, 75, 0.14)',
  'red':    '#f2727f', 'red-bg':    'rgba(242, 114, 127, 0.14)',
  'blue':   '#7cc4ff', 'blue-bg':   'rgba(124, 196, 255, 0.14)',
  'orange': '#f59e5b', 'orange-bg': 'rgba(245, 158, 91, 0.14)',
  // Depth.
  'shadow':    '0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.32)',
  'shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.35)',
  'glow':      '0 0 0 1px var(--accent-bg), 0 8px 30px rgba(93, 240, 238, 0.16)',
  'scrim':     'rgba(0, 0, 0, 0.55)',
};

const lightColors: ThemeColors = {
  'bg':            '#f7f8f7',
  'bg-accent':     '#eef3f3',
  'surface':       'rgba(255, 255, 255, 0.72)',
  'surface-2':     'rgba(255, 255, 255, 0.9)',
  'surface-solid': '#ffffff',
  'border':        'rgba(16, 27, 39, 0.1)',
  'border-strong': 'rgba(16, 27, 39, 0.18)',
  'text':          '#101b27',
  'muted':         '#5b6672',
  'subtle':        '#7b8692',
  'accent':          '#0b6f7a',
  'accent-strong':   '#085862',
  'accent-contrast': '#ffffff',
  'accent-bg':       'rgba(11, 111, 122, 0.1)',
  'primary':         '#22d3ee',
  'primary-strong':  '#1bbdd6',
  'on-primary':      '#06242a',
  'gold':    '#8a5a17', 'gold-bg':   'rgba(138, 90, 23, 0.1)',
  'green':  '#12805c', 'green-bg':  'rgba(18, 128, 92, 0.1)',
  'yellow': '#a35c00', 'yellow-bg': 'rgba(163, 92, 0, 0.1)',
  'red':    '#c03d49', 'red-bg':    'rgba(192, 61, 73, 0.1)',
  'blue':   '#1f6fc4', 'blue-bg':   'rgba(31, 111, 196, 0.1)',
  'orange': '#b4471a', 'orange-bg': 'rgba(180, 71, 26, 0.1)',
  'shadow':    '0 1px 2px rgba(16, 27, 39, 0.06), 0 10px 30px rgba(16, 27, 39, 0.08)',
  'shadow-sm': '0 1px 2px rgba(16, 27, 39, 0.08)',
  'glow':      '0 0 0 1px var(--accent-bg), 0 8px 30px rgba(11, 111, 122, 0.12)',
  'scrim':     'rgba(16, 27, 39, 0.45)',
};

export const colors: Record<ThemeName, ThemeColors> = { dark: darkColors, light: lightColors };

/** Tokens that do not change with the theme: shape, type, layout and motion. */
export const shared: Record<string, string> = {
  'radius':    '10px',
  'radius-sm': '7px',
  'radius-md': '10px',
  'radius-lg': '14px',
  'blur':      '14px',
  // Self-hosted (@fontsource-variable/geist and /geist-mono), so air-gapped installs keep them.
  'font-sans': "'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  'font-mono': "'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace",
  'sidebar-w':   '232px',
  'topbar-h':    '56px',
  'content-max': '1520px',
  'ease': 'cubic-bezier(0.16, 1, 0.3, 1)',
  // A QR code must stay black on white in both themes, or phones fail to scan it.
  'paper':     '#ffffff',
  'paper-ink': '#3f3f46',
};

/** One pair CI holds to a minimum contrast ratio, in every theme. */
export interface ContrastCheck {
  label: string;
  fg: string;
  bg: string;
  /** 4.5 for text (WCAG AA), 3 for non-text marks and large text (WCAG 1.4.11 / 1.4.3). */
  min: number;
}

export const contrastChecks: ContrastCheck[] = [
  { label: 'Body text on the page',        fg: 'text',            bg: 'bg',            min: 4.5 },
  { label: 'Body text on a card',          fg: 'text',            bg: 'surface-solid', min: 4.5 },
  { label: 'Muted text on the page',       fg: 'muted',           bg: 'bg',            min: 4.5 },
  { label: 'Muted text on a card',         fg: 'muted',           bg: 'surface-solid', min: 4.5 },
  { label: 'Link and accent text',         fg: 'accent',          bg: 'surface-solid', min: 4.5 },
  { label: 'Link and accent text, page',   fg: 'accent',          bg: 'bg',            min: 4.5 },
  { label: 'Text on an accent fill',       fg: 'accent-contrast', bg: 'accent',        min: 4.5 },
  { label: 'Button text on primary',       fg: 'on-primary',      bg: 'primary',       min: 4.5 },
  { label: 'Button text on hover',         fg: 'on-primary',      bg: 'primary-strong', min: 4.5 },
  { label: 'Gold tier text',               fg: 'gold',            bg: 'surface-solid', min: 4.5 },
  { label: 'Success text',                 fg: 'green',           bg: 'surface-solid', min: 4.5 },
  { label: 'Warning text',                 fg: 'yellow',          bg: 'surface-solid', min: 4.5 },
  { label: 'Danger text',                  fg: 'red',             bg: 'surface-solid', min: 4.5 },
  { label: 'Info text',                    fg: 'blue',            bg: 'surface-solid', min: 4.5 },
  { label: 'Orange text',                  fg: 'orange',          bg: 'surface-solid', min: 4.5 },
  { label: 'Focus ring and toggles',       fg: 'accent',          bg: 'bg',            min: 3 },
  { label: 'Subtle (non-essential) text',  fg: 'subtle',          bg: 'bg',            min: 3 },
];
