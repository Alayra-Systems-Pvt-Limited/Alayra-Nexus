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
import {
  isMutation, shouldAutoAudit, deriveAction, redactDetail,
  anonymizeIp, hashIdentifier, clampRetentionDays,
} from './audit';

describe('isMutation', () => {
  it('is true for state-changing methods only', () => {
    for (const m of ['POST', 'put', 'Patch', 'DELETE']) expect(isMutation(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isMutation(m)).toBe(false);
  });
});

describe('shouldAutoAudit', () => {
  it('records a successful mutation', () => {
    expect(shouldAutoAudit('/admin/keys/:id/ban', 'POST', 200)).toBe(true);
  });
  it('records a security-relevant denial (403/401) but drops validation noise (400)', () => {
    expect(shouldAutoAudit('/admin/keys/:id', 'DELETE', 403)).toBe(true);
    expect(shouldAutoAudit('/admin/keys/:id', 'DELETE', 401)).toBe(true);
    expect(shouldAutoAudit('/admin/providers', 'POST', 400)).toBe(false);
  });
  it('ignores reads and the explicitly-handled auth routes', () => {
    expect(shouldAutoAudit('/admin/usage', 'GET', 200)).toBe(false);
    expect(shouldAutoAudit('/admin/login', 'POST', 200)).toBe(false);
    expect(shouldAutoAudit('/admin/sso/callback', 'GET', 200)).toBe(false);
  });
});

describe('deriveAction', () => {
  it('collapses path params into one stable slug', () => {
    expect(deriveAction('DELETE', '/admin/keys/:id')).toBe('keys.delete');
    // 7.17b: removing a model used to ride the whole-registry PUT and log as `models.update`.
    expect(deriveAction('DELETE', '/admin/models/:id')).toBe('models.delete');
    expect(deriveAction('PUT', '/admin/models')).toBe('models.update');
    expect(deriveAction('POST', '/admin/keys/:id/ban')).toBe('keys.ban');
    expect(deriveAction('POST', '/admin/providers')).toBe('providers.create');
    expect(deriveAction('PUT', '/admin/settings/notifications')).toBe('settings.notifications');
    expect(deriveAction('PUT', '/admin/settings/compliance')).toBe('settings.compliance');
  });
});

describe('redactDetail', () => {
  it('masks credential-looking fields without dropping the shape', () => {
    const out = redactDetail({ name: 'ci', clientSecret: 'abc', apiKey: 'k', code: '123', role: 'viewer' });
    expect(out).toEqual({ name: 'ci', clientSecret: '[redacted]', apiKey: '[redacted]', code: '[redacted]', role: 'viewer' });
  });
  it('does not serialize nested objects, and tolerates non-objects', () => {
    expect(redactDetail({ meta: { a: 1 } })).toEqual({ meta: '[object]' });
    expect(redactDetail(null)).toEqual({});
    expect(redactDetail('nope')).toEqual({});
  });
});

describe('anonymizeIp', () => {
  it('drops the last IPv4 octet', () => {
    expect(anonymizeIp('203.0.113.7')).toBe('203.0.113.0');
  });
  it('keeps only the IPv6 network prefix', () => {
    expect(anonymizeIp('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234:5678::');
  });
  it('returns null for empty input and leaves an unknown format alone', () => {
    expect(anonymizeIp('')).toBeNull();
    expect(anonymizeIp(null)).toBeNull();
    expect(anonymizeIp('weird')).toBe('weird');
  });
});

describe('hashIdentifier', () => {
  it('is deterministic, prefixed, and non-reversible in length', () => {
    const a = hashIdentifier('session-xyz');
    expect(a).toBe(hashIdentifier('session-xyz'));
    expect(a).not.toBe(hashIdentifier('session-abc'));
    expect(a).toMatch(/^anon_[0-9a-f]{16}$/);
  });
});

describe('clampRetentionDays', () => {
  it('bounds to [0, 90]; 0 or negative means keep forever', () => {
    expect(clampRetentionDays(45)).toBe(45);
    expect(clampRetentionDays('30')).toBe(30);
    expect(clampRetentionDays(1000)).toBe(90);
    expect(clampRetentionDays(0)).toBe(0);
    expect(clampRetentionDays(-5)).toBe(0);
    expect(clampRetentionDays('nonsense')).toBe(0);
  });
});
