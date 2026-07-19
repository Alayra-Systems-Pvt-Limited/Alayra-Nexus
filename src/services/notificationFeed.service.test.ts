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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the mock factories (which vitest lifts to the top of the file) can see them.
const { claimed, redisSet, prismaMock } = vi.hoisted(() => {
  const claimed = new Set<string>();
  return {
    claimed,
    // Redis SET NX: the first claim per key wins, repeats coalesce to null.
    redisSet: vi.fn(async (key: string) => {
      if (claimed.has(key)) return null;
      claimed.add(key);
      return 'OK';
    }),
    prismaMock: {
      notification: {
        create:     vi.fn(async () => ({})),
        findMany:   vi.fn(async () => []),
        count:      vi.fn(async () => 0),
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    },
  };
});
vi.mock('../lib/redis',  () => ({ redis: { set: (...a: unknown[]) => redisSet(...(a as [string])) } }));
vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));

import {
  recordNotification, listNotifications, markNotificationRead, markAllNotificationsRead, pruneNotifications,
} from './notificationFeed.service';
import { keyBannedMessage, budgetThresholdMessage } from '../lib/notify';

beforeEach(() => {
  claimed.clear();
  redisSet.mockClear();
  Object.values(prismaMock.notification).forEach((f) => f.mockClear());
});

describe('recordNotification', () => {
  it('writes the alert with the section that raised it, for click-through', async () => {
    const written = await recordNotification(keyBannedMessage('openai', '●●●●1234'), 3600);
    expect(written).toBe(true);
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'keyBanned', section: 'nexus', dedupeKey: 'keyBanned:openai:●●●●1234',
      }),
    });
  });

  it('persists the message severity so the panel can tint it', async () => {
    await recordNotification(keyBannedMessage('openai', '●●●●1234'), 3600);
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ severity: 'critical' }),
    });
  });

  it('routes a budget alert to Teams, not to Nexus', async () => {
    await recordNotification(budgetThresholdMessage({
      teamId: 't1', teamName: 'Frontend', pct: 80, spendUsd: 8, budgetUsd: 10,
      period: 'monthly', windowId: '2026-07',
    }), 3600);
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'budgetThreshold', section: 'teams' }),
    });
  });

  it('coalesces a repeat within the window: a flapping key leaves one entry, not a storm', async () => {
    const msg = keyBannedMessage('openai', '●●●●1234');
    expect(await recordNotification(msg, 3600)).toBe(true);
    expect(await recordNotification(msg, 3600)).toBe(false);
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
  });

  it('claims its own key, separate from the send guard', async () => {
    // The send path releases its claim when a configured channel failed, so the next occurrence can
    // retry the email. Sharing one key would make that release re-insert an entry already in the bell.
    await recordNotification(keyBannedMessage('openai', '●●●●1234'), 3600);
    expect(redisSet).toHaveBeenCalledWith(
      'nexus:notify:feed:keyBanned:openai:●●●●1234', '1', 'EX', 3600, 'NX',
    );
  });

  it('never throws — the feed must not disturb a fire-and-forget caller', async () => {
    prismaMock.notification.create.mockRejectedValueOnce(new Error('db down'));
    await expect(recordNotification(keyBannedMessage('groq', '●●●●9999'), 3600)).resolves.toBe(false);
  });
});

describe('listNotifications', () => {
  it('counts every unread alert, not just the page being shown', async () => {
    // A badge that only counted the visible page would under-report the moment the feed grew
    // past one screen.
    prismaMock.notification.findMany.mockResolvedValueOnce([
      { id: 'n1', type: 'keyBanned', severity: 'critical', title: 't', body: 'b', section: 'nexus', readAt: null, createdAt: new Date('2026-07-16T10:00:00Z') },
    ] as never);
    prismaMock.notification.count.mockResolvedValueOnce(42 as never);

    const r = await listNotifications({ limit: 1 });
    expect(r.unreadCount).toBe(42);
    expect(r.notifications[0]).toMatchObject({ id: 'n1', severity: 'critical', read: false, createdAt: '2026-07-16T10:00:00.000Z' });
    expect(prismaMock.notification.count).toHaveBeenCalledWith({ where: { readAt: null } });
  });

  it('clamps an absurd limit rather than trying to serve it', async () => {
    await listNotifications({ limit: 100_000 });
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('filters to unread on request', async () => {
    await listNotifications({ unreadOnly: true });
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { readAt: null } }));
  });
});

describe('read state', () => {
  it('marks one alert read', async () => {
    prismaMock.notification.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    expect(await markNotificationRead('n1')).toBe(true);
  });

  it('treats an already-read alert as success, not a 404', async () => {
    prismaMock.notification.updateMany.mockResolvedValueOnce({ count: 0 } as never); // nothing to change
    prismaMock.notification.count.mockResolvedValueOnce(1 as never);                 // …but it exists
    expect(await markNotificationRead('n1')).toBe(true);
  });

  it('reports a genuinely missing alert', async () => {
    prismaMock.notification.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    prismaMock.notification.count.mockResolvedValueOnce(0 as never);
    expect(await markNotificationRead('gone')).toBe(false);
  });

  it('marks all unread read and reports how many changed', async () => {
    prismaMock.notification.updateMany.mockResolvedValueOnce({ count: 5 } as never);
    expect(await markAllNotificationsRead()).toBe(5);
  });
});

describe('pruneNotifications', () => {
  it('deletes past the window', async () => {
    prismaMock.notification.deleteMany.mockResolvedValueOnce({ count: 9 } as never);
    expect(await pruneNotifications(30)).toBe(9);
    expect(prismaMock.notification.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: expect.any(Date) } } });
  });

  it('keeps everything when the window is 0, matching the audit and usage windows', async () => {
    expect(await pruneNotifications(0)).toBe(0);
    expect(prismaMock.notification.deleteMany).not.toHaveBeenCalled();
  });
});
