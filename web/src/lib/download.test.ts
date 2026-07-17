import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { download } from './download';

// jsdom implements Blob and anchor elements but not object URLs; stub the pair and watch the anchor.
let created: string[] = [];
let revoked: string[] = [];
// Record the anchor's attributes at click time rather than aliasing the element, which is both
// what we actually want to assert and what keeps the lint rule against `this` aliasing happy.
let clickedNames: string[] = [];
let clickedHrefs: string[] = [];

beforeEach(() => {
  created = []; revoked = []; clickedNames = []; clickedHrefs = [];
  vi.stubGlobal('URL', class {
    static createObjectURL() { const u = `blob:mock/${created.length}`; created.push(u); return u; }
    static revokeObjectURL(u: string) { revoked.push(u); }
  });
  // Intercept the programmatic click so jsdom does not attempt a real navigation.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedNames.push(this.download);
    clickedHrefs.push(this.href);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('download', () => {
  it('hands the browser an anchor with the given filename and clicks it', () => {
    download('nexus-recovery.txt', 'code-1\ncode-2');
    expect(clickedNames).toEqual(['nexus-recovery.txt']);
    expect(created).toHaveLength(1);
    expect(clickedHrefs[0]).toContain('blob:mock/');
  });

  it('removes the anchor and revokes the object URL so nothing leaks', () => {
    vi.useFakeTimers();
    download('f.txt', 'x');
    // The anchor is gone from the document immediately…
    expect(document.querySelector('a[download]')).toBeNull();
    // …and the blob URL is revoked on the next tick (revoking synchronously can cancel the save).
    expect(revoked).toHaveLength(0);
    vi.runAllTimers();
    expect(revoked).toEqual(created);
  });
});
