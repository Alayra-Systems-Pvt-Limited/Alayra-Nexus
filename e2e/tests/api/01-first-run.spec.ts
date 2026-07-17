import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack, ADMIN_PASSWORD } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// The life of a gateway, from first boot to claimed — one story, in order. Each step's
// precondition is the previous step's outcome, so a failure stops the story: serial mode
// makes the remaining steps skip rather than fail confusingly against wrong state.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

test('a fresh install reports itself unclaimed', async () => {
  const res = await gw.get<{ unclaimed: boolean; carriesExistingTwoFactor: boolean }>('/admin/setup/status');
  expect(res.status).toBe(200);
  expect(res.body.unclaimed).toBe(true);
  // A fresh install has no legacy authenticator to promise a carry-over for.
  expect(res.body.carriesExistingTwoFactor).toBe(false);
});

test('before claiming, the master password signs in exactly as Phase 6 did', async () => {
  // The upgrade non-event: an operator who updates and does nothing must notice nothing.
  const res = await gw.post<{ token: string }>('/admin/login', { body: { password: ADMIN_PASSWORD } });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();

  const status = await gw.get('/admin/status', res.body.token);
  expect(status.status).toBe(200);
});

test('claiming with the wrong master password is refused', async () => {
  const res = await gw.post('/admin/setup/claim', {
    body: { masterPassword: 'not-the-install-secret', ...OWNER },
  });
  expect(res.status).toBe(401);
});

test('claiming with a weak account password is refused with a reason', async () => {
  const res = await gw.post<{ error: string }>('/admin/setup/claim', {
    body: { masterPassword: ADMIN_PASSWORD, ...OWNER, password: 'short' },
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/characters/i);
});

test('claiming creates the owner, signs them in, and shows the recovery key once', async () => {
  const res = await gw.post<{
    token: string; role: string; recoveryKey: string; twoFactorCarriedOver: boolean;
    user: { email: string; role: string };
  }>('/admin/setup/claim', { body: { masterPassword: ADMIN_PASSWORD, ...OWNER } });

  expect(res.status).toBe(200);
  expect(res.body.role).toBe('owner');
  expect(res.body.user.email).toBe(OWNER.email);
  expect(res.body.token).toBeTruthy();
  // 128 bits in hyphenated groups of four — the shape a person can read back over a call.
  expect(res.body.recoveryKey).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
  // No authenticator existed on this fresh install, so nothing carried over.
  expect(res.body.twoFactorCarriedOver).toBe(false);
});

test('the gateway now reports itself claimed, and a second claim is refused', async () => {
  const status = await gw.get<{ unclaimed: boolean }>('/admin/setup/status');
  expect(status.body.unclaimed).toBe(false);

  const again = await gw.post('/admin/setup/claim', {
    body: { masterPassword: ADMIN_PASSWORD, name: 'Intruder', email: 'later@e2e.alayra.com', password: 'a-perfectly-long-password' },
  });
  expect(again.status).toBe(409);
});

test('after claiming, the master password no longer signs anyone in', async () => {
  // The password that installed the gateway is now a claim ticket, not a key to the door.
  const bare = await gw.post('/admin/login', { body: { password: ADMIN_PASSWORD } });
  expect(bare.status).toBe(401);

  const withEmail = await gw.post('/admin/login', { body: { email: OWNER.email, password: ADMIN_PASSWORD } });
  expect(withEmail.status).toBe(401);
});

test('the owner signs in with their email and their own password', async () => {
  const token = await gw.login(OWNER.email, OWNER.password);
  const status = await gw.get('/admin/status', token);
  expect(status.status).toBe(200);
});
