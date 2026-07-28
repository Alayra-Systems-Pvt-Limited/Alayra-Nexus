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

// Reading a number out of the environment without lying about it (Phase A3).
//
// `parseInt(process.env.X ?? '5000', 10)` is the pattern this codebase uses in twenty-two places,
// and it fails silently in three different ways that an operator will never see:
//
//     parseInt('2gb', 10)        === 2        a 2 GB upload cap becomes TWO BYTES
//     parseInt('30m', 10)        === 30       a 30-minute timeout becomes 30 MILLISECONDS
//     parseInt('1_800_000', 10)  === 1        a JS-style literal becomes 1 ms
//     parseInt('unlimited', 10)  === NaN      and `NaN ?? fallback` is NaN, because ?? only
//                                             catches null and undefined
//
// Every one of those is plausible input from someone who has read the README and not the source.
// The last is the worst: NaN survives the `??` that looks like it is guarding, and reaches whatever
// consumes it — for a Prisma transaction timeout, that is undefined behaviour in a code path that
// only runs when somebody is restoring their data after losing a server.
//
// So: parse strictly, refuse anything that is not plainly a number, say so once, and fall back to a
// value that works. Refusing loudly at boot would be the other defensible choice, but these are read
// on request paths — a gateway that will not start because a timeout was spelled "30m" trades a
// small misconfiguration for a total outage.

/** Names already complained about, so a per-request read does not fill the log with one mistake. */
const warned = new Set<string>();

export interface EnvIntOptions {
  /** Values below this are raised to it. A zero timeout is not a smaller timeout, it is a bug. */
  min?: number;
  /** Values above this are lowered to it. */
  max?: number;
}

/**
 * An integer from the environment, or `fallback` when it is unset or unusable.
 *
 * Read per call rather than at import: it keeps the value testable without module resets, and the
 * cost is a string parse on a path that is already doing database work.
 *
 * Only plain digits are accepted. No units, no separators, no signs — every caller here wants a
 * positive count of bytes or milliseconds, and being generous about the format is how "30m" becomes
 * thirty milliseconds.
 */
export function envInt(name: string, fallback: number, opts: EnvIntOptions = {}): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return clamp(fallback, opts);

  if (!/^\d+$/.test(raw)) {
    complain(name, raw, `it must be a whole number of ${unitHint(name)}, digits only`, fallback);
    return clamp(fallback, opts);
  }

  const parsed = Number(raw);
  // Beyond 2^53 an integer stops being exactly representable, so a value that large is a typo
  // rather than an intention, and silently rounding it would be its own small lie.
  if (!Number.isSafeInteger(parsed)) {
    complain(name, raw, 'it is too large to be exact', fallback);
    return clamp(fallback, opts);
  }

  const clamped = clamp(parsed, opts);
  if (clamped !== parsed) complain(name, raw, `it is outside the supported range`, clamped);
  return clamped;
}

function clamp(value: number, { min, max }: EnvIntOptions): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

/** A nudge in the right direction, based on the only two kinds of number read this way. */
function unitHint(name: string): string {
  if (/_MS$/.test(name)) return 'milliseconds';
  if (/_BYTES$/.test(name)) return 'bytes';
  return 'units';
}

function complain(name: string, raw: string, why: string, using: number): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`⚠️  ${name}="${raw}" was ignored — ${why}. Using ${using}.`);
}

/** Test-only: forget what has been complained about, so each case can assert the warning. */
export function resetEnvWarnings(): void {
  warned.clear();
}
