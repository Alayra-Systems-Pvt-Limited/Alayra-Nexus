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
  stripTrailingSlash, assertHttpUrl, assertSafeUrl,
  isPrivateHost, parseAllowList, ssrfPolicyFromEnv, type SsrfPolicy,
} from './url';

const BLOCKING: SsrfPolicy = { allowPrivate: false, allowList: new Set() };

describe('stripTrailingSlash', () => {
  it('removes a single trailing slash', () => {
    expect(stripTrailingSlash('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('removes multiple trailing slashes', () => {
    expect(stripTrailingSlash('https://api.example.com///')).toBe('https://api.example.com');
  });

  it('leaves a slash-free string untouched', () => {
    expect(stripTrailingSlash('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('handles an empty string', () => {
    expect(stripTrailingSlash('')).toBe('');
  });
});

describe('assertHttpUrl', () => {
  it('accepts https and http URLs', () => {
    expect(assertHttpUrl('https://api.anthropic.com/v1').protocol).toBe('https:');
    expect(assertHttpUrl('http://localhost:11434/v1').protocol).toBe('http:');
  });

  it('rejects non-http schemes', () => {
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow();
    expect(() => assertHttpUrl('gopher://internal')).toThrow();
  });

  it('rejects malformed URLs', () => {
    expect(() => assertHttpUrl('not a url')).toThrow();
  });
});

describe('isPrivateHost', () => {
  it('flags loopback and metadata IPs', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('flags RFC 1918 private ranges', () => {
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    expect(isPrivateHost('172.16.5.4')).toBe(true);
    expect(isPrivateHost('172.31.255.1')).toBe(true);
    expect(isPrivateHost('192.168.0.10')).toBe(true);
  });

  it('does not flag public ranges near private ones', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('api.openai.com')).toBe(false);
  });

  it('flags loopback names and internal TLDs', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('db.internal')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
  });

  it('flags private IPv6 (loopback, ULA, link-local, mapped)', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false); // public (Cloudflare)
  });
});

describe('assertSafeUrl', () => {
  it('allows public provider URLs', () => {
    expect(assertSafeUrl('https://api.anthropic.com/v1', BLOCKING).hostname).toBe('api.anthropic.com');
  });

  it('blocks private/internal hosts by default', () => {
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data', BLOCKING)).toThrow(/SSRF/);
    expect(() => assertSafeUrl('http://localhost:11434/v1', BLOCKING)).toThrow(/SSRF/);
    expect(() => assertSafeUrl('http://10.0.0.5/v1', BLOCKING)).toThrow(/SSRF/);
  });

  it('still enforces the http(s) scheme', () => {
    expect(() => assertSafeUrl('file:///etc/passwd', BLOCKING)).toThrow();
  });

  it('permits an allowlisted host (with or without port)', () => {
    const policy: SsrfPolicy = { allowPrivate: false, allowList: new Set(['localhost:11434']) };
    expect(assertSafeUrl('http://localhost:11434/v1', policy).port).toBe('11434');
    // a different port on the same host is still blocked
    expect(() => assertSafeUrl('http://localhost:9999/v1', policy)).toThrow(/SSRF/);
    // host-only allowlist entry permits any port
    const hostOnly: SsrfPolicy = { allowPrivate: false, allowList: new Set(['localhost']) };
    expect(assertSafeUrl('http://localhost:9999/v1', hostOnly).hostname).toBe('localhost');
  });

  it('permits everything when blocking is disabled', () => {
    const open: SsrfPolicy = { allowPrivate: true, allowList: new Set() };
    expect(assertSafeUrl('http://127.0.0.1:8080/v1', open).hostname).toBe('127.0.0.1');
  });
});

describe('parseAllowList / ssrfPolicyFromEnv', () => {
  it('normalizes comma- and newline-separated hosts', () => {
    const set = parseAllowList('localhost:11434, 127.0.0.1\nHost.Example');
    expect(set.has('localhost:11434')).toBe(true);
    expect(set.has('127.0.0.1')).toBe(true);
    expect(set.has('host.example')).toBe(true); // lower-cased
  });

  it('defaults to blocking ON with an empty allowlist', () => {
    const p = ssrfPolicyFromEnv({} as NodeJS.ProcessEnv);
    expect(p.allowPrivate).toBe(false);
    expect(p.allowList.size).toBe(0);
  });

  it('honors SSRF_ALLOW_PRIVATE truthy values', () => {
    expect(ssrfPolicyFromEnv({ SSRF_ALLOW_PRIVATE: 'true' } as NodeJS.ProcessEnv).allowPrivate).toBe(true);
    expect(ssrfPolicyFromEnv({ SSRF_ALLOW_PRIVATE: 'no' } as NodeJS.ProcessEnv).allowPrivate).toBe(false);
  });
});
