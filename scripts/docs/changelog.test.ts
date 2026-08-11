import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The changelog is the file an evaluator opens to answer two questions: is this maintained, and
// what changed. It renders on the repository landing page and on the npm package page, so it is a
// shipped artefact in the same sense the README is — and unlike the README it has no compiler, no
// linter and no size limit that anyone would notice blowing.
//
// It went wrong exactly that quietly. A PR added an `### Internal` entry under `[Unreleased]` and,
// in the same hunk, removed the `## [1.6.0] - 2026-08-09` line that immediately followed it. One
// deleted line among 329 added ones; the diff read as an insertion. The result stood on main for
// eleven commits: a released, tagged, published version whose thousand lines of notes were filed
// under "not released yet", and a front page claiming the last release was three weeks older than
// it was.
//
// Nothing here re-reads git. CI checks out at depth 1, so tags are not present — a guard written
// against `git tag` would pass on every run by finding nothing, which is worse than no guard. Both
// invariants below are decided from two files that are always on disk.

const ROOT      = resolve(__dirname, '..', '..');
const CHANGELOG = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
const VERSION   = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version as string;

interface Release { version: string; date: string; line: number }

/** Every `## [x.y.z] - YYYY-MM-DD` heading, in the order the file lists them. `[Unreleased]` is
 *  deliberately not one of these: it is the absence of a release, and treating it as one is how a
 *  release comes to be described as unreleased. */
function releases(): Release[] {
  const out: Release[] = [];
  CHANGELOG.split('\n').forEach((text, i) => {
    const m = /^## \[(\d+\.\d+\.\d+)\](?:\s*-\s*(\S+))?/.exec(text);
    if (m) out.push({ version: m[1], date: m[2] ?? '', line: i + 1 });
  });
  return out;
}

const rank = (v: string) => v.split('.').map(Number).reduce((acc, n) => acc * 1_000_000 + n, 0);

describe('the changelog agrees with the version being shipped', () => {
  it('has a heading for the version in package.json', () => {
    // The invariant that failed. `package.json` is bumped as part of releasing, so by the time a
    // version is in it, that version has notes — and if it does not, every reader is being told
    // that the code they are looking at has never been released.
    const found = releases().map((r) => r.version);
    expect(
      found,
      `package.json is ${VERSION}, and CHANGELOG.md has no "## [${VERSION}]" heading — its newest ` +
      `release is ${found[0] ?? 'none at all'}. Either the release notes are still sitting under ` +
      `[Unreleased], or the heading was deleted.`,
    ).toContain(VERSION);
  });

  it('names that version at the top, above every older one', () => {
    // A heading restored in the wrong place is the same bug wearing a fix: the release exists, and
    // is buried where nobody scrolling the front page will reach it.
    expect(releases()[0]?.version).toBe(VERSION);
  });

  it('still keeps an [Unreleased] section, and keeps it first', () => {
    // Deleting it is the other way to lose the boundary: with nowhere to put in-flight work, the
    // next entry lands under the newest release and silently claims to have shipped in it.
    const unreleased = CHANGELOG.indexOf('\n## [Unreleased]');
    expect(unreleased, 'CHANGELOG.md has no ## [Unreleased] section').toBeGreaterThan(-1);
    expect(unreleased).toBeLessThan(CHANGELOG.indexOf(`\n## [${VERSION}]`));
  });
});

describe('the release history reads in order', () => {
  const all = releases();

  it('lists versions newest first', () => {
    for (let i = 1; i < all.length; i++) {
      expect(
        rank(all[i - 1].version),
        `${all[i].version} (line ${all[i].line}) is listed above ${all[i - 1].version}`,
      ).toBeGreaterThan(rank(all[i].version));
    }
  });

  it('never lists the same version twice', () => {
    // What a bad merge of two release branches leaves behind: two sections, both plausible, and no
    // way for a reader to know which one describes the tag they installed.
    const seen = all.map((r) => r.version);
    expect(seen).toEqual([...new Set(seen)]);
  });

  it('dates every release, in a format a reader and a machine both parse', () => {
    for (const r of all) {
      expect(r.date, `## [${r.version}] on line ${r.line} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('never dates an older release after a newer one', () => {
    // Dates are the part a human actually reads, and they are hand-typed. A transposed month makes
    // the project look abandoned or the history look impossible, and neither is visible in a diff.
    for (let i = 1; i < all.length; i++) {
      expect(
        all[i].date <= all[i - 1].date,
        `${all[i].version} is dated ${all[i].date}, after ${all[i - 1].version} on ${all[i - 1].date}`,
      ).toBe(true);
    }
  });
});
