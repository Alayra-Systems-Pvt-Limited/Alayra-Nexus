import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// The README is a shipped artefact, not just documentation: it is the npm package page, and npm
// stores only the first 64 KB of it. Nothing about that failure is loud — the package publishes
// cleanly and the page simply stops mid-sentence, usually somewhere after the part that would have
// told a reader why to install it. It happened: the README reached 81,843 bytes before anybody
// noticed, and the fix was to move five reference sections into docs/.
//
// So this is a size budget with tests attached, and the tests exist because a budget nobody
// measures is a budget that is already blown.

const ROOT   = resolve(__dirname, '..', '..');
const README = resolve(ROOT, 'README.md');

/** https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md — the registry
 *  serves the first 64 KB of the readme for the most recently published version. */
const NPM_README_LIMIT = 64 * 1024;

const bytes = (path: string) => Buffer.byteLength(readFileSync(path, 'utf8'), 'utf8');

/** Markdown link targets, minus external URLs and pure anchors. */
function localLinks(markdown: string): string[] {
  const out: string[] = [];
  for (const [, target] of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    out.push(target.split('#')[0]);
  }
  return [...new Set(out.filter(Boolean))];
}

describe('the README fits on the npm package page', () => {
  it('is inside npm\'s 64 KB limit', () => {
    expect(bytes(README)).toBeLessThan(NPM_README_LIMIT);
  });

  it('keeps enough headroom that the next section does not silently truncate it', () => {
    // A README at 64,500 bytes passes the check above and is one paragraph from being cut off in
    // public, with no signal until someone opens the npm page and scrolls. 8 KB is roughly the
    // largest section in the file, so a whole new section can land before this needs a decision.
    const headroom = NPM_README_LIMIT - bytes(README);
    expect(headroom, `only ${headroom} bytes left — move a section into docs/`).toBeGreaterThan(8 * 1024);
  });
});

describe('the pages the README hands off to', () => {
  const readme = readFileSync(README, 'utf8');

  it('all exist', () => {
    // Splitting a README is the moment its links break, and a broken link in the shop window is
    // read as a broken project. Both the README's own links and the moved pages' way back are
    // checked, because the rewrite that fixed one direction is exactly what breaks the other.
    for (const target of localLinks(readme)) {
      expect(existsSync(resolve(ROOT, target)), `README links to ${target}, which does not exist`).toBe(true);
    }
  });

  it('link back to something real', () => {
    const docs = readdirSync(resolve(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
    for (const doc of docs) {
      const path = resolve(ROOT, 'docs', doc);
      for (const target of localLinks(readFileSync(path, 'utf8'))) {
        expect(existsSync(resolve(dirname(path), target)), `docs/${doc} links to ${target}, which does not exist`).toBe(true);
      }
    }
  });

  it('say where they came from, so an orphaned page is obvious', () => {
    // A page with no route back to the README reads as abandoned notes. Every page split out of the
    // README carries a line naming its origin.
    for (const doc of ['standalone.md', 'backup.md', 'routing.md', 'api.md', 'security.md']) {
      expect(readFileSync(resolve(ROOT, 'docs', doc), 'utf8')).toContain('../README.md#');
    }
  });

  it('are not gitignored', () => {
    // `docs/*` is ignored wholesale so internal planning documents stay internal, with named
    // exceptions for the public ones. A page split out of the README and left un-excepted exists
    // on the author's disk, passes every check they run, and reaches everyone else as a 404 on the
    // project's front page. It had already happened once, to the verification evidence.
    //
    // Existence alone cannot catch this locally — the file is right there. Only git knows.
    const git = spawnSync('git', ['check-ignore', ...localLinks(readme)],
      // git is a .cmd shim on Windows and will not spawn directly. The first version of this test
      // omitted that, swallowed the ENOENT as "no git here", and passed while checking nothing —
      // which is how a guard becomes a green tick that means nothing.
      { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
    expect(git.error, 'could not run git, so this guard checked nothing').toBeUndefined();
    expect(git.status, `git check-ignore failed: ${git.stderr}`).not.toBe(128);
    expect(git.stdout.trim(), 'the README links to these, and .gitignore hides them').toBe('');
  });

  it('are reachable from the README', () => {
    const linked = new Set(localLinks(readme));
    for (const doc of ['standalone.md', 'backup.md', 'routing.md', 'api.md', 'security.md']) {
      expect(linked.has(`docs/${doc}`), `nothing in the README links to docs/${doc}`).toBe(true);
    }
  });
});
