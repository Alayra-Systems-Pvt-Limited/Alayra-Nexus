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

import { colors, shared, type ThemeColors } from './tokens';

// ── tokens.css ────────────────────────────────────────────────────────────────────────────────
// Renders the tokens as CSS custom properties. Dark is the default theme (`:root` with no
// attribute); `<html data-theme="light">` switches, exactly as the dashboard does today.

const HEADER = `/*
 * Alayra Nexus design tokens — GENERATED, do not edit.
 * Source: packages/ui-tokens/src/tokens.ts · regenerate with \`npm run tokens:build\`.
 * Dark is the default; <html data-theme="light"> switches to the light palette.
 */
`;

function block(selector: string, scheme: string | null, values: ThemeColors): string {
  const width = Math.max(...Object.keys(values).map((name) => name.length)) + 3;
  const lines = Object.entries(values).map(([name, value]) => `  ${`--${name}:`.padEnd(width)}${value};`);
  return `${selector} {\n${scheme ? `  color-scheme: ${scheme};\n\n` : ''}${lines.join('\n')}\n}\n`;
}

/** The complete stylesheet, byte-for-byte stable for a given token set. */
export function renderTokensCss(): string {
  return [
    HEADER,
    block(":root,\n:root[data-theme='dark']", 'dark', colors.dark),
    block(":root[data-theme='light']", 'light', colors.light),
    block(':root', null, shared),
  ].join('\n');
}
