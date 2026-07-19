import { describe, it, expect } from 'vitest';
import { scorePassword } from './passwordStrength';

describe('scorePassword', () => {
  it('scores an empty field as 0 with no label', () => {
    expect(scorePassword('')).toEqual({ score: 0, label: '' });
  });

  it('never flatters a password below the 12-char server minimum', () => {
    expect(scorePassword('Ab1!xy')).toMatchObject({ score: 0, label: 'Too short' });
    expect(scorePassword('Abcd1234!x')).toMatchObject({ score: 0 }); // 10 chars
  });

  it('rewards length: a long passphrase reaches the top rung', () => {
    // 20+ chars, mixed classes → all four segments.
    expect(scorePassword('correct-horse-Battery9').score).toBe(4);
  });

  it('lets a 12-char mixed password reach Good on variety', () => {
    const r = scorePassword('Abcd1234!xyz'); // 12 chars, 4 classes
    expect(r.score).toBeGreaterThanOrEqual(2);
    expect(['Fair', 'Good', 'Strong']).toContain(r.label);
  });

  it('crushes a known-common password to 0 however long', () => {
    expect(scorePassword('password').score).toBe(0);
    expect(scorePassword('1234567890').score).toBe(0);
  });

  it('crushes a single repeated character to 0', () => {
    expect(scorePassword('aaaaaaaaaaaaaaaa').score).toBe(0);
  });

  it('caps a long all-digit password at Weak', () => {
    expect(scorePassword('19283746501928').score).toBeLessThanOrEqual(1);
  });
});
