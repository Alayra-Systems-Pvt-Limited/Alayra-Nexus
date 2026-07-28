/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Every case below is a real value `parseInt` accepts and turns into something else. They are not
// hypothetical: "2gb" for a byte cap and "30m" for a millisecond timeout are what a person writes
// after reading a README, and both currently produce a working gateway that quietly does the wrong
// thing — a two-byte upload limit, a thirty-millisecond restore budget.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { envInt, resetEnvWarnings } from './envNumber';

const NAME = 'NEXUS_TEST_VALUE_MS';

beforeEach(() => {
  delete process.env[NAME];
  resetEnvWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env[NAME];
  vi.restoreAllMocks();
});

describe('reading a number that is really there', () => {
  it('returns it', () => {
    process.env[NAME] = '600000';
    expect(envInt(NAME, 1)).toBe(600_000);
  });

  it('tolerates surrounding whitespace, which a .env file and a compose file both produce', () => {
    process.env[NAME] = '  600000  ';
    expect(envInt(NAME, 1)).toBe(600_000);
  });

  it('accepts zero when no floor forbids it', () => {
    process.env[NAME] = '0';
    expect(envInt(NAME, 99)).toBe(0);
  });
});

describe('falling back', () => {
  it('uses the fallback when the variable is unset', () => {
    expect(envInt(NAME, 1234)).toBe(1234);
  });

  it('uses the fallback when the variable is empty', () => {
    process.env[NAME] = '';
    expect(envInt(NAME, 1234)).toBe(1234);
  });

  it('uses the fallback when the variable is only whitespace', () => {
    process.env[NAME] = '   ';
    expect(envInt(NAME, 1234)).toBe(1234);
  });

  it('applies the floor to the fallback too', () => {
    // Otherwise a caller could ship a default below its own stated minimum and never find out.
    expect(envInt(NAME, 5, { min: 100 })).toBe(100);
  });
});

describe('the values parseInt silently mangles', () => {
  it.each([
    ['2gb',        'a byte cap that parseInt reads as 2'],
    ['30m',        'a timeout that parseInt reads as 30'],
    ['1_800_000',  'a JS-style literal that parseInt reads as 1'],
    ['unlimited',  'a word that parseInt reads as NaN'],
    ['1.5',        'a decimal that parseInt truncates'],
    ['1e6',        'exponent notation that parseInt reads as 1'],
    ['-1',         'a negative, which no caller here wants'],
    ['0x10',       'hex, which parseInt base 10 reads as 0'],
  ])('refuses %s (%s) and uses the fallback', (raw) => {
    process.env[NAME] = raw;
    expect(envInt(NAME, 4242)).toBe(4242);
  });

  it('says so, naming both what was set and what is being used', () => {
    // Falling back silently is how "I set the variable and nothing happened" becomes a support
    // ticket nobody can reproduce.
    process.env[NAME] = '30m';
    envInt(NAME, 4242);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('30m'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('4242'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('milliseconds'));
  });

  it('complains once per variable, not once per read', () => {
    // These are read per request. One typo must not become a log line per restore.
    process.env[NAME] = 'nonsense';
    envInt(NAME, 1); envInt(NAME, 1); envInt(NAME, 1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a value too large to be an exact integer', () => {
    process.env[NAME] = '9007199254740993';   // 2^53 + 1
    expect(envInt(NAME, 7)).toBe(7);
  });
});

describe('bounds', () => {
  it('raises a value below the floor', () => {
    process.env[NAME] = '5';
    expect(envInt(NAME, 1000, { min: 100 })).toBe(100);
  });

  it('lowers a value above the ceiling', () => {
    process.env[NAME] = '999999';
    expect(envInt(NAME, 10, { max: 5000 })).toBe(5000);
  });

  it('says when it clamped, because the operator asked for something else', () => {
    process.env[NAME] = '5';
    envInt(NAME, 1000, { min: 100 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('range'));
  });

  it('leaves a value inside the range alone and says nothing', () => {
    process.env[NAME] = '500';
    expect(envInt(NAME, 1, { min: 100, max: 5000 })).toBe(500);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('the unit hint follows the variable name', () => {
  it('says bytes for a _BYTES variable', () => {
    process.env.NEXUS_TEST_VALUE_BYTES = '2gb';
    envInt('NEXUS_TEST_VALUE_BYTES', 1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('bytes'));
    delete process.env.NEXUS_TEST_VALUE_BYTES;
  });
});
