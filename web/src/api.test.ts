import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, GET, POST, DEL, ApiError, setToken, getToken } from './api';

/**
 * The network seam. Every page in the dashboard reaches the gateway through this file, and until
 * now nothing tested it — which is exactly how it shipped sending `Content-Type: application/json`
 * on requests that carried no body. The gateway rejected all of them before the route ran, and the
 * page tests never saw it because they mock this module out entirely.
 *
 * The rule these tests hold: what we put on the wire is the contract, so assert on the wire.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  ok({});
});

afterEach(() => { vi.unstubAllGlobals(); });

/** A successful JSON response. */
function ok(body: unknown): void {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** A failed response carrying `body` as its text, the way fetch delivers one. */
function fail(status: number, body: string): void {
  fetchMock.mockResolvedValue({ ok: false, status, text: () => Promise.resolve(body) });
}

/** The RequestInit handed to fetch on the last call. */
function sent(): RequestInit & { headers: Record<string, string> } {
  return fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
}

describe('request body and content type', () => {
  it('sends no Content-Type when there is no body', async () => {
    await POST('/admin/auth/totp/enrol');

    // The regression. `Content-Type: application/json` is a promise that a JSON body follows;
    // sending it with nothing behind it made the gateway answer FST_ERR_CTP_EMPTY_JSON_BODY.
    expect(sent().headers['Content-Type']).toBeUndefined();
    expect(sent().body).toBeUndefined();
  });

  it('sends no Content-Type on a bodyless DELETE', async () => {
    await DEL('/admin/users/u1');
    expect(sent().headers['Content-Type']).toBeUndefined();
  });

  it('sends no Content-Type on a GET', async () => {
    await GET('/admin/config');
    expect(sent().headers['Content-Type']).toBeUndefined();
  });

  it('sends Content-Type and a serialized body when there is one', async () => {
    await POST('/admin/teams', { name: 'Platform' });
    expect(sent().headers['Content-Type']).toBe('application/json');
    expect(sent().body).toBe('{"name":"Platform"}');
  });

  it('sends a body of null as JSON, not as nothing', async () => {
    // `null` is a value a route may legitimately be given; only `undefined` means "no body".
    await api('PATCH', '/admin/team-keys/k1', { teamId: null });
    expect(sent().headers['Content-Type']).toBe('application/json');
    expect(sent().body).toBe('{"teamId":null}');
  });

  it('always carries the bearer token', async () => {
    setToken('tok_abc');
    await POST('/admin/auth/totp/enrol');
    expect(sent().headers.Authorization).toBe('Bearer tok_abc');
  });
});

describe('error messages', () => {
  it('surfaces the sentence from our own error shape', async () => {
    fail(403, JSON.stringify({ error: 'This action needs owner access. Your account is admin.' }));
    await expect(GET('/admin/users')).rejects.toThrow('This action needs owner access. Your account is admin.');
  });

  it('surfaces the readable part of a framework error, not the raw JSON', async () => {
    // What the Security page printed on screen, verbatim, before this fix.
    fail(400, JSON.stringify({
      statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
      error: 'Bad Request', message: "Body cannot be empty when content-type is set to 'application/json'",
    }));

    const err = await GET('/admin/config').catch((e: unknown) => e as ApiError);
    expect((err as ApiError).message).toBe("Body cannot be empty when content-type is set to 'application/json'");
    expect((err as ApiError).message).not.toContain('statusCode');
    expect((err as ApiError).message).not.toContain('FST_ERR');
  });

  it('falls back to the raw text when the body is not JSON', async () => {
    fail(502, 'Bad Gateway');
    await expect(GET('/admin/config')).rejects.toThrow('Bad Gateway');
  });

  it('falls back to the status when there is no body at all', async () => {
    fail(500, '');
    await expect(GET('/admin/config')).rejects.toThrow('HTTP 500');
  });

  it('carries the status on the error', async () => {
    fail(403, JSON.stringify({ error: 'nope' }));
    const err = await GET('/admin/users').catch((e: unknown) => e as ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});

describe('session expiry', () => {
  it('clears the token and announces a 401', async () => {
    setToken('tok_abc');
    const onUnauth = vi.fn();
    window.addEventListener('nx:unauthorized', onUnauth);
    fail(401, JSON.stringify({ error: 'Unauthorized' }));

    await GET('/admin/config').catch(() => {});

    expect(getToken()).toBe('');
    expect(onUnauth).toHaveBeenCalled();
    window.removeEventListener('nx:unauthorized', onUnauth);
  });

  it('leaves the session alone on a 403', async () => {
    // A viewer hitting an owner-only route is not a lost session: the token is valid, the action
    // just is not allowed. Signing them out here would be a bug that looks like a security feature.
    setToken('tok_abc');
    fail(403, JSON.stringify({ error: 'This action needs owner access.' }));

    await GET('/admin/users').catch(() => {});

    expect(getToken()).toBe('tok_abc');
  });
});
