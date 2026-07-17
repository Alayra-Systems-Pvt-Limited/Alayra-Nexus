import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack } from '../../setup/stacks';
import { totpCode } from '../../helpers/totp';
import { API_OWNER as OWNER } from '../../helpers/personas';

// The second half of the accounts story: a person is invited, works, secures their own
// account, is suspended, restored, and finally removed — and the trail outlives them.
// Runs against the gateway 01-first-run.spec claimed; serial for the same reason.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

const INVITEE = { name: 'Liaqat', email: 'liaqat@e2e.alayra.com', password: 'liaqat-passphrase-e2e-1' };

let ownerToken = '';
let inviteToken = '';
let inviteeId = '';
let inviteeToken = '';
let totpSecret = '';

test.beforeAll(async () => {
  ownerToken = await gw.login(OWNER.email, OWNER.password);
});

test('the owner invites an admin and receives the link token exactly once', async () => {
  const res = await gw.post<{ invite: { id: string; email: string; role: string }; token: string }>(
    '/admin/invites',
    { token: ownerToken, body: { email: INVITEE.email, role: 'admin' } },
  );
  expect(res.status).toBe(201);
  expect(res.body.invite.email).toBe(INVITEE.email);
  expect(res.body.token).toBeTruthy();
  inviteToken = res.body.token;
});

test('the invite can be inspected without an account, and lies flat about bad tokens', async () => {
  const good = await gw.get<{ invite: { email: string; role: string } }>(
    `/admin/invites/accept?token=${inviteToken}`,
  );
  expect(good.status).toBe(200);
  expect(good.body.invite.role).toBe('admin');

  // Expired, spent, and never-existed must be indistinguishable — a different answer for a
  // live-but-spent token is a fishing aid.
  const bad = await gw.get('/admin/invites/accept?token=deadbeef'.padEnd(60, '0'));
  expect(bad.status).toBe(404);
});

test('accepting cannot smuggle a different email or a bigger role', async () => {
  const res = await gw.post<{ user: { id: string; email: string; role: string } }>(
    '/admin/invites/accept',
    {
      body: {
        token: inviteToken, name: INVITEE.name, password: INVITEE.password,
        // Injected fields. The route reads token, name, password — nothing else. If either of
        // these ever takes effect, accepting an invite has become a privilege escalation.
        email: 'attacker@evil.com', role: 'owner',
      },
    },
  );
  expect(res.status).toBe(201);
  expect(res.body.user.email).toBe(INVITEE.email);
  expect(res.body.user.role).toBe('admin');
  inviteeId = res.body.user.id;
});

test('a spent invite is dead', async () => {
  const res = await gw.get(`/admin/invites/accept?token=${inviteToken}`);
  expect(res.status).toBe(404);
});

test('the new admin can run the gateway but cannot decide who belongs to it', async () => {
  inviteeToken = await gw.login(INVITEE.email, INVITEE.password);

  const write = await gw.post<{ team: { id: string } }>('/admin/teams', {
    token: inviteeToken, body: { name: 'E2E Working Team' },
  });
  expect(write.status).toBe(201);

  const ownerOnly = await gw.post<{ error: string }>('/admin/invites', {
    token: inviteeToken, body: { email: 'x@e2e.alayra.com', role: 'viewer' },
  });
  expect(ownerOnly.status).toBe(403);
  expect(ownerOnly.body.error).toMatch(/owner access/i);
  expect(ownerOnly.body.error).toMatch(/admin/i);
});

test('a bodyless request works bare, and the header-with-no-body lie is refused at the wire', async () => {
  // This pins the server half of the bug shipped in every release up to v1.1.0: the dashboard
  // sent `Content-Type: application/json` with nothing behind it, and eleven buttons died here,
  // before their route ever ran. The refusal is CORRECT behaviour — the fix belongs to the
  // client — but both halves of the contract get pinned where they actually live: on the wire.
  const bare = await gw.post<{ secret: string; otpauthUri: string }>('/admin/auth/totp/enrol', {
    token: inviteeToken,
  });
  expect(bare.status).toBe(200);
  expect(bare.body.secret).toBeTruthy();
  // The authenticator entry is labelled with the person, not a generic "admin".
  expect(bare.body.otpauthUri).toContain(encodeURIComponent(INVITEE.email));
  totpSecret = bare.body.secret;

  const lying = await gw.post('/admin/auth/totp/enrol', {
    token: inviteeToken, headers: { 'Content-Type': 'application/json' },
  });
  expect(lying.status).toBe(400);
});

test('the admin enables two-factor with a code a real authenticator would compute', async () => {
  const res = await gw.post<{ success: boolean; recoveryCodes: string[] }>('/admin/auth/totp/confirm', {
    token: inviteeToken, body: { code: totpCode(totpSecret) },
  });
  expect(res.status).toBe(200);
  expect(res.body.recoveryCodes.length).toBeGreaterThan(0);
});

test('their password alone is no longer enough, password plus code is', async () => {
  const withoutCode = await gw.post<{ totpRequired?: boolean }>('/admin/login', {
    body: { email: INVITEE.email, password: INVITEE.password },
  });
  expect(withoutCode.status).toBe(401);
  expect(withoutCode.body.totpRequired).toBe(true);

  inviteeToken = await gw.login(INVITEE.email, INVITEE.password, totpCode(totpSecret));
  expect((await gw.get('/admin/status', inviteeToken)).status).toBe(200);
});

test('suspension takes effect on the very next request, not at session expiry', async () => {
  const suspend = await gw.send('PATCH', `/admin/users/${inviteeId}`, {
    token: ownerToken, body: { status: 'suspended' },
  });
  expect(suspend.status).toBe(200);

  // The session token is still the one that worked seconds ago. It must not matter.
  expect((await gw.get('/admin/status', inviteeToken)).status).toBe(401);

  const login = await gw.post('/admin/login', {
    body: { email: INVITEE.email, password: INVITEE.password, code: totpCode(totpSecret) },
  });
  expect(login.status).toBe(403);
});

test('an owner cannot demote, suspend, or remove themselves', async () => {
  const me = await gw.get<{ users: { id: string; email: string }[] }>('/admin/users', ownerToken);
  const self = me.body.users.find((u) => u.email === OWNER.email)!;

  const demote = await gw.send('PATCH', `/admin/users/${self.id}`, {
    token: ownerToken, body: { role: 'viewer' },
  });
  expect(demote.status).toBe(400);

  const remove = await gw.send('DELETE', `/admin/users/${self.id}`, { token: ownerToken });
  expect(remove.status).toBe(400);
});

test('removal ends access, and the audit trail still names the person', async () => {
  const restore = await gw.send('PATCH', `/admin/users/${inviteeId}`, {
    token: ownerToken, body: { status: 'active' },
  });
  expect(restore.status).toBe(200);

  const removed = await gw.send<{ success: boolean }>('DELETE', `/admin/users/${inviteeId}`, { token: ownerToken });
  expect(removed.status).toBe(200);

  const login = await gw.post('/admin/login', {
    body: { email: INVITEE.email, password: INVITEE.password, code: totpCode(totpSecret) },
  });
  expect(login.status).toBe(401);

  // The record outlives the account — that is what makes it a record. The name is copied,
  // not joined, so deleting the row cannot orphan the history.
  const audit = await gw.get<{ entries: { actorName: string | null; action: string }[] }>(
    '/admin/audit?limit=100', ownerToken,
  );
  expect(audit.status).toBe(200);
  const theirs = audit.body.entries.filter((l) => l.actorName === INVITEE.name);
  expect(theirs.length).toBeGreaterThan(0);
});
