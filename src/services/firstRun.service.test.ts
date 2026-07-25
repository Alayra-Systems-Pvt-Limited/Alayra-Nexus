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

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { prismaMock, usersMock } = vi.hoisted(() => ({
  prismaMock: {
    adminAuth:         { findUnique: vi.fn(), update: vi.fn(() => 'update-auth') },
    adminUser:         { update: vi.fn(() => 'update-user') },
    adminRecoveryCode: { updateMany: vi.fn(() => 'adopt-codes') },
    // The claim must be atomic: an owner who half-exists is an owner who cannot sign in.
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  usersMock: { createUser: vi.fn(), isUnclaimed: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres', prisma: prismaMock }));
// The factory reset pulls in Redis scanning and both drain pipelines; none of the claim tests
// exercise them, but importing the real modules would demand a live REDIS_URL at test time.
vi.mock('../lib/redisScan', () => ({ deleteKeys: vi.fn(async () => 0) }));
vi.mock('./audit.service', () => ({ drainAudit: vi.fn(async () => undefined) }));
vi.mock('./usagePipeline', () => ({ drainUsage: vi.fn(async () => undefined) }));
vi.mock('./adminUsers.service', async () => {
  // The real error class travels through: the routes map its `status`, so a stub that threw a plain
  // Error would let a broken status mapping pass unnoticed.
  const actual = await vi.importActual<typeof import('./adminUsers.service')>('./adminUsers.service');
  return { ...actual, createUser: usersMock.createUser, isUnclaimed: usersMock.isUnclaimed };
});

import { claimGateway, getClaimStatus } from './firstRun.service';

const MASTER = 'the-master-password';
const OWNER = { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'owner' as const };

const INPUT = { masterPassword: MASTER, name: 'Ada', email: 'ada@example.com', password: 'a properly long password' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_PASSWORD = MASTER;
  usersMock.isUnclaimed.mockResolvedValue(true);
  usersMock.createUser.mockResolvedValue({ user: OWNER, recoveryKey: 'aaaa-bbbb-cccc-dddd' });
  prismaMock.adminAuth.findUnique.mockResolvedValue(null);
});

describe('getClaimStatus', () => {
  it('reports an unclaimed gateway, and whether an authenticator will carry over', async () => {
    prismaMock.adminAuth.findUnique.mockResolvedValue({ totpSecret: 'enc:S', confirmedAt: new Date() });
    expect(await getClaimStatus()).toEqual({ unclaimed: true, carriesExistingTwoFactor: true });

    // Enrolled but never confirmed is not a working factor, so there is nothing to carry.
    prismaMock.adminAuth.findUnique.mockResolvedValue({ totpSecret: 'enc:S', confirmedAt: null });
    expect(await getClaimStatus()).toEqual({ unclaimed: true, carriesExistingTwoFactor: false });
  });

  it('says nothing about a second factor once claimed', async () => {
    usersMock.isUnclaimed.mockResolvedValue(false);
    expect(await getClaimStatus()).toEqual({ unclaimed: false, carriesExistingTwoFactor: false });
  });
});

describe('claimGateway — the environment secret is the claim ticket', () => {
  it('creates the first owner and hands back a recovery key once', async () => {
    const result = await claimGateway(INPUT);
    expect(result).toMatchObject({ user: OWNER, recoveryKey: 'aaaa-bbbb-cccc-dddd', twoFactorCarriedOver: false });
    expect(usersMock.createUser).toHaveBeenCalledWith({
      email: 'ada@example.com', name: 'Ada', password: 'a properly long password',
      role: 'owner', source: 'local',
    });
  });

  it('refuses without the administrator password from the environment', async () => {
    // Otherwise whoever reaches an unclaimed gateway first would own it — the land-grab that
    // anyone who can route to the port wins.
    await expect(claimGateway({ ...INPUT, masterPassword: 'guess' })).rejects.toThrow(/administrator password/);
    await expect(claimGateway({ ...INPUT, masterPassword: 'guess' })).rejects.toMatchObject({ status: 401 });
    expect(usersMock.createUser).not.toHaveBeenCalled();
  });

  it('refuses when ADMIN_PASSWORD is unset, rather than letting anyone claim', async () => {
    delete process.env.ADMIN_PASSWORD;
    await expect(claimGateway({ ...INPUT, masterPassword: '' })).rejects.toThrow(/not set on the server/);
    expect(usersMock.createUser).not.toHaveBeenCalled();
  });

  it('refuses to claim a gateway that already has an owner', async () => {
    usersMock.isUnclaimed.mockResolvedValue(false);
    await expect(claimGateway(INPUT)).rejects.toThrow(/already been set up/);
    await expect(claimGateway(INPUT)).rejects.toMatchObject({ status: 409 });
  });
});

describe('claimGateway — carrying an existing second factor across', () => {
  beforeEach(() => {
    prismaMock.adminAuth.findUnique.mockResolvedValue({
      id: 'singleton', totpSecret: 'enc:SECRET', confirmedAt: new Date('2026-01-01'),
    });
  });

  it('moves the secret onto the owner, adopts their codes, and NULLS the original', async () => {
    // An operator who enrolled in Phase 6 has that authenticator on a phone and those codes in a
    // safe. Claiming must not quietly invalidate either — and must not leave a second live copy
    // of the secret behind in a deprecated table.
    const result = await claimGateway(INPUT);
    expect(result.twoFactorCarriedOver).toBe(true);

    expect(prismaMock.adminUser.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { totpSecret: 'enc:SECRET', totpConfirmedAt: new Date('2026-01-01') },
    });
    // Unused codes only: a spent code must not come back to life as somebody's.
    expect(prismaMock.adminRecoveryCode.updateMany).toHaveBeenCalledWith({
      where: { userId: null, usedAt: null },
      data:  { userId: 'u1' },
    });
    expect(prismaMock.adminAuth.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data:  { totpSecret: null, confirmedAt: null },
    });
    // All three together, or none: an owner with a half-moved factor could be locked out.
    expect(prismaMock.$transaction).toHaveBeenCalledWith(['update-user', 'adopt-codes', 'update-auth']);
  });

  it('touches nothing when the old enrolment was never confirmed', async () => {
    prismaMock.adminAuth.findUnique.mockResolvedValue({ id: 'singleton', totpSecret: 'enc:S', confirmedAt: null });
    const result = await claimGateway(INPUT);
    expect(result.twoFactorCarriedOver).toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
