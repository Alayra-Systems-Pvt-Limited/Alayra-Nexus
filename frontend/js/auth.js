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

// A submitted password with no code counts against the lockout, so remember on this
// browser that a factor is enrolled and ask for the code up front. Only a hint: the
// server decides, and a stale hint costs nothing.
const TOTP_HINT_KEY = 'nx_totp_enrolled';

/** Reveal the authenticator field once we know a second factor is set. */
export function showTotpField() {
  const row = document.getElementById('login-totp-row');
  if (!row) return;
  row.style.display = '';
  localStorage.setItem(TOTP_HINT_KEY, '1');
}

/** Called at boot: pre-reveal the field if this browser has seen the factor before. */
export function restoreTotpHint() {
  if (localStorage.getItem(TOTP_HINT_KEY) === '1') showTotpField();
}

// Plain-language reasons for a bounced SSO sign-in. The server only ever hands back a
// stable code; the raw IdP error is never exposed.
const SSO_ERRORS = {
  not_configured:        'Single sign-on is not configured on this gateway.',
  discovery_failed:      'Could not reach the identity provider. Check the issuer URL.',
  invalid_request:       'The sign-in request was invalid. Please try again.',
  state_expired:         'The sign-in took too long. Please try again.',
  token_exchange_failed: 'The identity provider rejected the sign-in.',
  no_id_token:           'The identity provider did not return an identity token.',
  verification_failed:   'Your identity could not be verified. Please try again.',
};

/**
 * Boot the SSO login option: reveal the button when the server reports an enabled IdP,
 * and if we arrived back from a failed handshake (`?sso_error=`), show why and clean the URL.
 */
export async function initSso() {
  const params = new URLSearchParams(location.search);
  const err = params.get('sso_error');
  if (err) {
    showError(SSO_ERRORS[err] || 'Single sign-on failed. Please try again.');
    history.replaceState(null, '', location.pathname); // drop the code from the address bar
  }
  try {
    const res = await fetch('/admin/sso/enabled');
    if (!res.ok) return;
    const { enabled, displayName } = await res.json();
    if (!enabled) return;
    const block = document.getElementById('sso-block');
    const btn   = document.getElementById('sso-btn');
    if (btn && displayName) btn.textContent = `Sign in with ${displayName}`;
    if (block) block.style.display = '';
  } catch {
    /* no SSO offered when the probe cannot complete */
  }
}

/** Reflect the signed-in role in the shell (Phase 6.5): a read-only banner and a body flag
 *  a viewer session can key off. The server is the real gate; this is only presentation. */
function applyRole() {
  const viewer = state.role === 'viewer';
  document.body.classList.toggle('viewer-mode', viewer);
  const banner = document.getElementById('readonly-banner');
  if (banner) banner.style.display = viewer ? '' : 'none';
}

function enterApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  applyRole();
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
    if (body.totpRequired) {
      showTotpField();
      document.getElementById('login-totp').focus();
      showError('Enter your authenticator code.');
      return;
    }
    showError(body.error || 'Incorrect password');
    return;
  }

  const { token, role } = await res.json();
  // Signed in without a code, so the factor was disabled since we last saw it.
  if (!code) localStorage.removeItem(TOTP_HINT_KEY);
  state.token = token;
  state.role  = role || 'owner';
  sessionStorage.setItem('nx_token', token);
  sessionStorage.setItem('nx_role', state.role);
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
    state.role = d.role || 'owner';
    sessionStorage.setItem('nx_role', state.role);
    enterApp();
  } catch {
    state.token = '';
    sessionStorage.removeItem('nx_token');
  }
}
