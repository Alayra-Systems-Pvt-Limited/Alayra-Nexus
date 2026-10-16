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

import { describe, it, expect } from 'vitest';
import { callerErrorBody, classifyFailure, nativeAnswerHeaders } from './upstreamFailure';

const anthropic = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'error', error: { type, message: 'Your organization org-123 has hit a limit.', ...extra }, request_id: 'req_1' });

describe('classifyFailure on Anthropic\'s own API', () => {
  it.each([
    [401, 'authentication_error', 'auth'],
    [403, 'permission_error', 'client'],
    [402, 'billing_error', 'rate_limit'],
    [429, 'rate_limit_error', 'rate_limit'],
    [529, 'overloaded_error', 'server'],
    [500, 'api_error', 'server'],
    [504, 'timeout_error', 'server'],
    [400, 'invalid_request_error', 'client'],
    [413, 'request_too_large', 'client'],
    [404, 'not_found_error', 'client'],
  ])('%i %s → %s', (status, type, kind) => {
    expect(classifyFailure(status, anthropic(type), true)).toBe(kind);
  });

  it('never counts a 401 or 403 without authentication_error toward a ban', () => {
    expect(classifyFailure(401, 'Unauthorized', true)).toBe('client');
    expect(classifyFailure(403, anthropic('brand_new_error'), true)).toBe('client');
    expect(classifyFailure(503, anthropic('brand_new_error'), true)).toBe('server');
  });
});

describe('classifyFailure on the translated path', () => {
  it('goes by status, as before', () => {
    expect(classifyFailure(401, '{}', false)).toBe('auth');
    expect(classifyFailure(403, anthropic('permission_error'), false)).toBe('auth');
    expect(classifyFailure(429, '', false)).toBe('rate_limit');
    expect(classifyFailure(502, '', false)).toBe('server');
    expect(classifyFailure(400, '', false)).toBe('client');
  });
});

describe('callerErrorBody', () => {
  it('keeps Anthropic\'s error type and request id for a tenant on a shared key, and replaces the words', () => {
    const out = JSON.parse(callerErrorBody(429, anthropic('rate_limit_error', { details: { error_code: 'x' } }), true));
    expect(out).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: expect.any(String) }, request_id: 'req_1' });
    expect(out.error.message).not.toContain('org-123');
  });

  it('keeps an OpenAI-style type and code, and replaces the words', () => {
    const text = JSON.stringify({ error: { message: 'Rate limit reached in organization org-123', type: 'requests', code: 'rate_limit_exceeded', param: null } });
    const out = JSON.parse(callerErrorBody(429, text, true));
    expect(out).toEqual({ error: { message: expect.any(String), type: 'requests', code: 'rate_limit_exceeded' } });
    expect(JSON.parse(callerErrorBody(401, 'not json', true))).toEqual({ error: { message: expect.any(String) } });
  });

  it('leaves the words for the account\'s owner, and every other status alone', () => {
    expect(callerErrorBody(429, anthropic('rate_limit_error'), false)).toBe(anthropic('rate_limit_error'));
    expect(callerErrorBody(400, anthropic('invalid_request_error'), true)).toBe(anthropic('invalid_request_error'));
    expect(callerErrorBody(529, anthropic('overloaded_error'), true)).toBe(anthropic('overloaded_error'));
  });
});

describe('nativeAnswerHeaders', () => {
  it('marks the answer, names what was stripped, and relays only retry and request-id headers', () => {
    const upstream = new Response(null, { headers: {
      'retry-after': '7', 'request-id': 'req_1', 'x-should-retry': 'true',
      'anthropic-organization-id': 'org-123', 'anthropic-ratelimit-requests-remaining': '0', 'set-cookie': 'a=b',
    } });
    expect(nativeAnswerHeaders(upstream, ['speed'])).toEqual({
      'X-Nexus-Native': 'anthropic', 'X-Nexus-Stripped': 'speed', 'retry-after': '7', 'request-id': 'req_1', 'x-should-retry': 'true',
    });
    expect(nativeAnswerHeaders(new Response(null), [])).toEqual({ 'X-Nexus-Native': 'anthropic' });
  });
});
