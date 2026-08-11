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

// ── What "per minute" means, defined once ─────────────────────────────────────────────────────
//
// Two scripts admit requests against a key's RPM and TPM: `SELECT_KEY_LUA`, which the request path
// actually calls, and `ADMIT_LUA`, which is the single-key primitive. They had the same rule
// written out twice, and that is how one bug came to live in two places — the fix for #135 was
// applied to `ADMIT_LUA` first, changed nothing a caller could see, and only the rig caught it.
//
// So the rule lives here now, in one Lua fragment and one TypeScript function, and both scripts
// paste in the same text.
//
// ── The rule ──────────────────────────────────────────────────────────────────────────────────
//
// Two counters per limit, one per window, and the previous one weighted by how much of it is still
// inside the trailing window:
//
//     count = current + previous * (1 - elapsed/window)
//
// Ten seconds into a minute, five sixths of the previous minute is still in range and counts for
// five sixths. Fifty seconds in, one sixth. The measure moves continuously rather than jumping, so
// there is no boundary to burst across — which a fixed window, resetting on schedule, would allow:
// the full limit in its last second plus the full limit in the next window's first is twice the
// rating inside two seconds, against a number whose whole purpose is not exceeding what the
// provider permits.
//
// Two counters, no per-request storage. The cost is one extra key per limit and nothing that grows
// with traffic.
//
// ── Whose clock ───────────────────────────────────────────────────────────────────────────────
//
// `nowMs` comes from the caller, which is the convention `SELECT_KEY_LUA` already used for the
// breaker's cooldown. Instances therefore have to agree on the time to agree on the window, and
// with NTP they agree to milliseconds against a window of sixty seconds. A skewed instance does not
// get its own budget — it counts into a neighbouring window of the same shared counters, so the
// error is bounded by the skew rather than by the limit. `npm run bench:multi-instance` is what
// would catch it going wrong.

/** Lua definitions both admission scripts paste in. Defines `nexusWindow` and `nexusCount`. */
export const RATE_WINDOW_LUA = `
local function nexusWindow(prefix, nowMs, windowSec)
  local windowMs = windowSec * 1000
  local index = math.floor(nowMs / windowMs)
  -- Formatted, never concatenated raw: a Lua number stringifies in scientific notation once it is
  -- large enough, and a key called nexus:rpm:x:2.9281234e+07 counts nothing anybody will read.
  return prefix .. ':' .. string.format('%d', index),
         prefix .. ':' .. string.format('%d', index - 1),
         1 - ((nowMs % windowMs) / windowMs)
end

local function nexusCount(cur, prev, weight)
  return tonumber(redis.call('GET', cur) or '0')
       + tonumber(redis.call('GET', prev) or '0') * weight
end
`;

export interface RateWindow {
  /** The counter this instant falls in. */
  current: string;
  /** The one before it, still partly inside the trailing window. */
  previous: string;
  /** How much of `previous` is still in range: 1 at the start of a window, 0 at its end. */
  weight: number;
}

/** The TypeScript twin of `nexusWindow`. */
export function rateWindow(prefix: string, nowMs: number, windowSeconds: number): RateWindow {
  const windowMs = windowSeconds * 1000;
  const index = Math.floor(nowMs / windowMs);
  return {
    current:  `${prefix}:${index}`,
    previous: `${prefix}:${index - 1}`,
    weight:   1 - ((nowMs % windowMs) / windowMs),
  };
}

/** The TypeScript twin of `nexusCount`. `get` is the store's synchronous read. */
export function rateCount(w: RateWindow, get: (key: string) => string | null): number {
  return Number(get(w.current) ?? '0') + Number(get(w.previous) ?? '0') * w.weight;
}

/**
 * How long a window's counter must live.
 *
 * Two windows, because the current one is read again as "previous" from the next. Expiry is set on
 * the window's own key, so it is a deadline rather than a countdown that use keeps resetting — the
 * distinction that was the whole of #135.
 */
export const windowTtl = (windowSeconds: number): number => windowSeconds * 2;
