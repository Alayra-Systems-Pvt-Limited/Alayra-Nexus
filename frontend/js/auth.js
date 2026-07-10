// Sign-in.
//
// The password is exchanged at /admin/login for a short-lived session token, and only
// that token is kept. The admin password is never written to sessionStorage: any XSS
// on this page would read it straight out, and it is the credential that protects
// every provider key in the gateway.
import { state }   from './state.js';
import { initApp } from './app.js';

function showError(msg) {
  document.getElementById('login-err').textContent = msg || '';
}

/** Reveal the authenticator field once the server tells us a second factor is set. */
function showTotpField() {
  const row = document.getElementById('login-totp-row');
  if (!row) return;
  row.style.display = '';
  document.getElementById('login-totp').focus();
}

function enterApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  initApp();
}

export async function doLogin() {
  const password = document.getElementById('login-pwd').value.trim();
  const code     = (document.getElementById('login-totp')?.value || '').trim();
  if (!password) return;
  showError('');

  let res;
  try {
    res = await fetch('/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password, ...(code ? { code } : {}) }),
    });
  } catch {
    showError('Cannot reach the gateway.');
    return;
  }

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    showError(body.error || 'Too many attempts. Try again later.');
    return;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // A second factor is enrolled and the password was accepted; ask for the code.
    if (body.totpRequired) { showTotpField(); showError('Enter your authenticator code.'); return; }
    showError(body.error || 'Incorrect password');
    return;
  }

  const { token } = await res.json();
  state.token = token;
  sessionStorage.setItem('nx_token', token);
  enterApp();
}

/**
 * Restore a session from sessionStorage if the stored token is still live. Called once
 * at boot; an expired or revoked token is discarded and the login screen stays up.
 */
export async function restoreSession() {
  if (!state.token) return;
  try {
    const res = await fetch('/admin/status', { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error('unauthorized');
    const d = await res.json();
    if (d.ok === undefined) throw new Error('unexpected response');
    enterApp();
  } catch {
    state.token = '';
    sessionStorage.removeItem('nx_token');
  }
}
