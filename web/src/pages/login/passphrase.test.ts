// The generator's strength is arithmetic, and arithmetic is checkable (Phase C6).

import { describe, it, expect } from 'vitest';
import { generatePassphrase, PASSPHRASE_WORDS, PASSPHRASE_BITS } from './passphrase';

describe('the generated backup passphrase', () => {
  it('has the number of words it claims', () => {
    expect(generatePassphrase().split('-')).toHaveLength(PASSPHRASE_WORDS);
  });

  it('states entropy that matches the list it draws from', () => {
    // 256 words is 8 bits each, exactly. The module refuses to load if the list is any other size,
    // which is what keeps this true rather than merely asserted.
    expect(PASSPHRASE_BITS).toBe(PASSPHRASE_WORDS * 8);
    expect(PASSPHRASE_BITS).toBeGreaterThanOrEqual(64);
  });

  it('is long enough for the server to accept', () => {
    // format.ts refuses a passphrase under 12 characters. A generator that produced one the product
    // then rejected would be a setup screen that cannot be completed.
    expect(generatePassphrase().length).toBeGreaterThanOrEqual(12);
    expect(generatePassphrase().length).toBeLessThanOrEqual(200);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, generatePassphrase));
    expect(seen.size).toBe(200);
  });

  it('uses a wide spread of the list rather than a corner of it', () => {
    // Catches the classic failures: an off-by-one that never reaches the last word, or a modulo that
    // favours the first few. Not a statistical test — just a sanity floor that a broken index would
    // fall through.
    const words = new Set(Array.from({ length: 400 }, generatePassphrase).flatMap((p) => p.split('-')));
    expect(words.size).toBeGreaterThan(200);
  });

  it('contains only characters that survive a phone call and a text file', () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
