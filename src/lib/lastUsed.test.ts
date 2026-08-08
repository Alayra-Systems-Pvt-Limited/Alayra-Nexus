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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetLastUsed, shouldWriteLastUsed } from './lastUsed';

const WINDOW = 5_000;

beforeEach(() => forgetLastUsed());
afterEach(() => { delete process.env.LAST_USED_WRITE_WINDOW_MS; forgetLastUsed(); });

describe('shouldWriteLastUsed', () => {
  it('writes the first use of a key', () => {
    expect(shouldWriteLastUsed('k1', 1_000)).toBe(true);
  });

  it('suppresses every further use inside the window', () => {
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', 1)).toBe(false);
    expect(shouldWriteLastUsed('k1', 2_500)).toBe(false);
    expect(shouldWriteLastUsed('k1', WINDOW - 1)).toBe(false);
  });

  it('writes again once the window has passed', () => {
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', WINDOW)).toBe(true);
  });

  it('measures the window from the last WRITE, not the last use', () => {
    // The distinction is the whole bound on staleness. If suppressed uses reset the timer, a key
    // under continuous load would never be written again and its ordering would freeze permanently
    // — the exact failure this is supposed to avoid.
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    for (let t = 1; t < WINDOW; t += 500) shouldWriteLastUsed('k1', t);
    expect(shouldWriteLastUsed('k1', WINDOW)).toBe(true);
  });

  it('tracks keys independently', () => {
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k2', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', 100)).toBe(false);
    expect(shouldWriteLastUsed('k2', 100)).toBe(false);
  });

  it('writes every time when the window is zero', () => {
    process.env.LAST_USED_WRITE_WINDOW_MS = '0';
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', 1)).toBe(true);
    expect(shouldWriteLastUsed('k1', 2)).toBe(true);
  });

  it('honours a custom window', () => {
    process.env.LAST_USED_WRITE_WINDOW_MS = '100';
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', 99)).toBe(false);
    expect(shouldWriteLastUsed('k1', 100)).toBe(true);
  });

  it('falls back to the default when the window is not a usable number', () => {
    // A typo in an env var must not turn into "write on every request" or, worse, "never write".
    process.env.LAST_USED_WRITE_WINDOW_MS = 'soon';
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', WINDOW - 1)).toBe(false);
    expect(shouldWriteLastUsed('k1', WINDOW)).toBe(true);
  });
});

describe('forgetLastUsed', () => {
  it('makes the next use of a forgotten key write through', () => {
    expect(shouldWriteLastUsed('k1', 0)).toBe(true);
    expect(shouldWriteLastUsed('k1', 10)).toBe(false);
    forgetLastUsed('k1');
    expect(shouldWriteLastUsed('k1', 20)).toBe(true);
  });

  it('leaves other keys alone', () => {
    shouldWriteLastUsed('k1', 0);
    shouldWriteLastUsed('k2', 0);
    forgetLastUsed('k1');
    expect(shouldWriteLastUsed('k2', 10)).toBe(false);
  });

  it('clears everything when called with no key', () => {
    shouldWriteLastUsed('k1', 0);
    shouldWriteLastUsed('k2', 0);
    forgetLastUsed();
    expect(shouldWriteLastUsed('k1', 10)).toBe(true);
    expect(shouldWriteLastUsed('k2', 10)).toBe(true);
  });
});
