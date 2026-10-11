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

// ── @alayrasystems/nexus-ui-tokens ────────────────────────────────────────────────────────────
// The token values, the contrast maths CI holds them to, and the CSS renderer.

export { colors, shared, contrastChecks, type ThemeName, type ThemeColors, type ContrastCheck } from './tokens';
export { contrastRatio, luminance, parseHex } from './contrast';
export { renderTokensCss } from './css';
