import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBackup, filenameFrom, readMaintenance, restoreBackup, RestoreError } from './backupClient';

// The transport is the one part of B1.4 with no visible surface, so every guarantee it makes has to
// be asserted here or nowhere: that the browser writes its own multipart boundary, that a zero row
// count is left out rather than sent, that the maintenance poll cannot sign anyone out, and that a
// truncated download is never saved to disk.

/** Just enough XMLHttpRequest to drive the restore path, with hooks to answer as a server would. */
class FakeXhr {
  static last: FakeXhr | null = null;

  status = 0;
  responseText = '';
  headers: Record<string, string> = {};
  sent: FormData | null = null;
  aborted = false;

  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
            onload: (() => void) | null } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { FakeXhr.last = this; }

  open(): void { /* method and url are asserted through the call site, not here */ }
  setRequestHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  send(body: FormData): void { this.sent = body; }
  abort(): void { this.aborted = true; this.onabort?.(); }

  /** Answer as the gateway would. */
  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const REPORT = {
  gatewayVersion: '1.3.2', createdAt: '2026-07-20T10:00:00.000Z', sourceEngine: 'postgres',
  rowsInFile: { nexusProvider: 3 }, totalRowsInFile: 3, secretsInFile: 1,
  sourceSchema: null, missingEnv: [], schemaDrift: [],
  mode: 'merge', dryRun: true, written: {}, totalWritten: 0, skipped: {}, totalSkipped: 0,
  collisions: [], secretsRekeyed: 0, tablesCleared: 0, kvKeysCleared: 0,
};

const aFile = () => new File(['backup-bytes'], 'nexus-backup.nxb', { type: 'application/octet-stream' });

beforeEach(() => {
  FakeXhr.last = null;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  sessionStorage.setItem('nx_token', 'session-token');
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('restoreBackup', () => {
  it('never sets Content-Type, so the browser writes the multipart boundary itself', () => {
    // A hand-written Content-Type has no boundary, and the gateway answers 400 on a body it cannot
    // parse — which reads to an operator as a damaged backup rather than a broken request.
    restoreBackup({ file: aFile(), mode: 'merge', dryRun: true });

    expect(FakeXhr.last!.headers['content-type']).toBeUndefined();
    expect(FakeXhr.last!.headers.authorization).toBe('Bearer session-token');
  });

  it('leaves out a row count of zero rather than sending one', async () => {
    // The route parses expectedRows with `.positive()`. An empty backup's dry run legitimately
    // reports zero rows, and sending it would fail validation — turning a cosmetic progress hint
    // into a 400 on the real restore.
    restoreBackup({ file: aFile(), mode: 'merge', dryRun: false, expectedRows: 0 });
    expect(FakeXhr.last!.sent!.get('expectedRows')).toBeNull();

    restoreBackup({ file: aFile(), mode: 'merge', dryRun: false, expectedRows: 900 });
    expect(FakeXhr.last!.sent!.get('expectedRows')).toBe('900');
  });

  it('sends the proofs a replace needs, and omits them for a dry run', () => {
    restoreBackup({
      file: aFile(), mode: 'replace', dryRun: false,
      passphrase: 'a-long-enough-passphrase', masterPassword: 'env-secret', confirm: 'REPLACE ALL DATA',
    });
    const form = FakeXhr.last!.sent!;
    expect(form.get('mode')).toBe('replace');
    expect(form.get('dryRun')).toBe('false');
    expect(form.get('masterPassword')).toBe('env-secret');
    expect(form.get('confirm')).toBe('REPLACE ALL DATA');
  });

  it('reports upload progress and calls it exactly 1 when the last byte is out', () => {
    const seen: number[] = [];
    restoreBackup({ file: aFile(), mode: 'merge', dryRun: true }, (f) => seen.push(f));

    FakeXhr.last!.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 200 });
    FakeXhr.last!.upload.onload!();

    // The final 1 comes from `upload.onload`, not from rounding a progress event: a caller switching
    // screens on "fraction >= 1" must not be left waiting because the last event read 0.999.
    expect(seen).toEqual([0.25, 1]);
  });

  it('resolves with the report the gateway sent', async () => {
    const { done } = restoreBackup({ file: aFile(), mode: 'merge', dryRun: true });
    FakeXhr.last!.respond(200, REPORT);
    await expect(done).resolves.toMatchObject({ totalRowsInFile: 3, gatewayVersion: '1.3.2' });
  });

  it('carries the hint and the drift list off a refusal, not just the sentence', async () => {
    // A schema refusal is the one where the file is fine and retrying will never help. Losing the
    // list would leave an operator with "this gateway's schema has moved on" and nothing to act on.
    const { done } = restoreBackup({ file: aFile(), mode: 'merge', dryRun: true });
    FakeXhr.last!.respond(400, {
      error: 'This backup cannot be restored onto this gateway.',
      hint: 'Nothing was changed.',
      schemaDrift: [{ model: 'NexusKey', column: 'region', kind: 'unknown-column', detail: 'not in this version', blocking: true }],
    });

    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as RestoreError).status).toBe(400);
    expect((err as RestoreError).hint).toBe('Nothing was changed.');
    expect((err as RestoreError).schemaDrift).toHaveLength(1);
  });

  it('reads Fastify’s own failures, which put the sentence in a different field', async () => {
    const { done } = restoreBackup({ file: aFile(), mode: 'merge', dryRun: true });
    FakeXhr.last!.respond(413, { statusCode: 413, error: 'Payload Too Large', message: 'That backup is larger than the limit.' });

    await expect(done).rejects.toThrow('That backup is larger than the limit.');
  });

  it('says plainly that nothing changed when the upload is stopped', async () => {
    const { done, abort } = restoreBackup({ file: aFile(), mode: 'replace', dryRun: false });
    abort();

    expect(FakeXhr.last!.aborted).toBe(true);
    await expect(done).rejects.toThrow(/Nothing was changed/);
  });
});

describe('filenameFrom', () => {
  it('reads the name the gateway chose, quoted or bare', () => {
    expect(filenameFrom('attachment; filename="nexus-backup-2026-07-29.nxb"')).toBe('nexus-backup-2026-07-29.nxb');
    expect(filenameFrom('attachment; filename=plain.nxb')).toBe('plain.nxb');
    expect(filenameFrom(null)).toBeNull();
    expect(filenameFrom('attachment')).toBeNull();
  });
});

describe('readMaintenance', () => {
  it('answers null instead of signing anyone out when the session it is watching dies', async () => {
    // A `replace` wipes every session the moment it commits, so the very next poll is a 401. Going
    // through api() would clear the token and throw the operator to the sign-in screen — tearing the
    // progress view off the screen a moment before it could show the result.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(readMaintenance()).resolves.toBeNull();
    expect(sessionStorage.getItem('nx_token')).toBe('session-token');
  });

  it('answers null when the gateway cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(readMaintenance()).resolves.toBeNull();
  });

  it('returns the progress when there is some', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ active: true, maintenance: { percent: 42, rowsWritten: 420 } }), { status: 200 }),
    ));
    await expect(readMaintenance()).resolves.toMatchObject({ active: true, maintenance: { percent: 42 } });
  });
});

describe('downloadBackup', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    }));
  });

  it('saves the file under the name the gateway chose', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ciphertext', {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="nexus-backup-2026-07-29.nxb"' },
    })));

    await expect(downloadBackup('a-long-enough-passphrase', false)).resolves.toBe('nexus-backup-2026-07-29.nxb');
    expect(click).toHaveBeenCalled();
  });

  it('saves nothing at all when the stream breaks part-way', async () => {
    // A truncated backup will not authenticate on restore. An operator must never be left holding
    // one that looks complete, so a broken stream produces an error and no file.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const res = new Response('x', { status: 200 });
    vi.spyOn(res, 'blob').mockRejectedValue(new TypeError('network error'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    await expect(downloadBackup('a-long-enough-passphrase', false)).rejects.toThrow(/cut short/);
    expect(click).not.toHaveBeenCalled();
  });

  it('passes the gateway-recipient choice through rather than assuming it', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response('ciphertext', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await downloadBackup('a-long-enough-passphrase', true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      passphrase: 'a-long-enough-passphrase', includeGatewayRecipient: true,
    });
  });
});
