import { describe, it, expect } from 'vitest';
import { resolveScope, isIsolated, isByok, isByokOnly, SHARED_NAMESPACE } from './scope';

describe('resolveScope', () => {
  it('sends a request with no team to the shared pool', () => {
    const scope = resolveScope(null, 0);
    expect(scope).toEqual({ ownerTeamId: null, fallbackToShared: true, namespace: SHARED_NAMESPACE });
  });

  it('sends a team that owns no keys to the shared pool', () => {
    expect(resolveScope({ id: 't1' }, 0).ownerTeamId).toBeNull();
  });

  it('ignores byokFallback:false for a team that owns no keys', () => {
    // Isolation only governs fall-back *from* your own keys. A team with none is
    // just a normal shared-pool team — it must not be locked out of everything.
    const scope = resolveScope({ id: 't1', byokFallback: false }, 0);
    expect(scope.ownerTeamId).toBeNull();
    expect(isIsolated(scope)).toBe(false);
  });

  it('scopes a key-owning team to its own keys, with fall-back by default', () => {
    const scope = resolveScope({ id: 't1' }, 2);
    expect(scope.ownerTeamId).toBe('t1');
    expect(scope.fallbackToShared).toBe(true);
    expect(isByok(scope)).toBe(true);
    expect(isIsolated(scope)).toBe(false);
  });

  it('hard-isolates a key-owning team that disables fall-back', () => {
    const scope = resolveScope({ id: 't1', byokFallback: false }, 1);
    expect(isIsolated(scope)).toBe(true);
  });

  it('gives each team a distinct cache namespace, distinct from shared', () => {
    const a = resolveScope({ id: 'team-a' }, 1);
    const b = resolveScope({ id: 'team-b' }, 1);
    expect(a.namespace).not.toBe(b.namespace);
    expect(a.namespace).not.toBe(SHARED_NAMESPACE);
    expect(b.namespace).not.toBe(SHARED_NAMESPACE);
  });

  it('keeps a shared-pool team on the shared namespace', () => {
    expect(resolveScope({ id: 't1' }, 0).namespace).toBe(SHARED_NAMESPACE);
  });
});

// ── byok-only (P1.1) ──
describe('resolveScope — a byok-only team', () => {
  it('is scoped to its own keys with no fall-back, even when it owns none', () => {
    for (const owned of [0, 3]) {
      const scope = resolveScope({ id: 't1', isolation: 'byok-only' }, owned);
      expect(scope).toEqual({ ownerTeamId: 't1', fallbackToShared: false, namespace: 'team:t1', byokOnly: true });
      expect(isIsolated(scope)).toBe(true);
      expect(isByokOnly(scope)).toBe(true);
    }
  });

  it('ignores byokFallback: true — byok-only is the stronger setting', () => {
    expect(resolveScope({ id: 't1', byokFallback: true, isolation: 'byok-only' }, 2).fallbackToShared).toBe(false);
  });

  it('leaves every other team exactly as before', () => {
    expect(isByokOnly(resolveScope({ id: 't1' }, 0))).toBe(false);
    expect(isByokOnly(resolveScope({ id: 't1', byokFallback: false }, 1))).toBe(false);
    expect(resolveScope({ id: 't1' }, 0)).toEqual({ ownerTeamId: null, fallbackToShared: true, namespace: SHARED_NAMESPACE });
    expect(isByokOnly(resolveScope(null, 0))).toBe(false);
  });
});
