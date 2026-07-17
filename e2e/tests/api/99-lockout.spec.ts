import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// Deliberately the LAST file in the api project: the lockout it triggers is keyed to the
// source address, so once it fires, nothing else on this stack can sign in for fifteen
// minutes. Any spec added after this one alphabetically will find the door barred — that
// is the 99- prefix carrying real weight, not decoration.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

test('repeated failures lock the source out, and being right no longer helps', async () => {
  // Earlier specs made a few deliberate failed attempts from this address; the exact count
  // left in the window is not this test's business. What it asserts is the guarantee: the
  // lockout arrives within the advertised budget, never after it.
  let locked: { status: number; body: { retryAfter?: number } } | null = null;
  for (let i = 0; i < 6; i++) {
    const res = await gw.post<{ retryAfter?: number }>('/admin/login', {
      body: { email: OWNER.email, password: `wrong-guess-${i}` },
    });
    if (res.status === 429) { locked = res; break; }
    expect(res.status).toBe(401);
  }

  expect(locked, 'lockout never engaged within the attempt budget').not.toBeNull();
  expect(locked!.body.retryAfter).toBeGreaterThan(0);

  // The whole point of a source lockout: the CORRECT password is refused too. A guesser who
  // finally lands on the right one learns nothing and gets nothing.
  const rightAnswer = await gw.post('/admin/login', {
    body: { email: OWNER.email, password: OWNER.password },
  });
  expect(rightAnswer.status).toBe(429);
});
