// Sign-in. The password is verified against /admin/status before it is stored, so a
// wrong password never lands in sessionStorage.
import { state }   from './state.js';
import { initApp } from './app.js';

export async function doLogin() {
  const pwd = document.getElementById('login-pwd').value.trim();
  if (!pwd) return;
  state.pwd = pwd;
  const res = await fetch('/admin/status', { headers: { Authorization: `Bearer ${pwd}` } });
  if (res.status === 401) { document.getElementById('login-err').textContent = 'Incorrect password'; return; }
  sessionStorage.setItem('nx_pwd', pwd);
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  initApp();
}

/**
 * Restore a session from sessionStorage, if the stored password still works. Called
 * once at boot; a stale password is discarded and the login screen stays up.
 */
export async function restoreSession() {
  if (!state.pwd) return;
  try {
    const res = await fetch('/admin/status', { headers: { Authorization: `Bearer ${state.pwd}` } });
    if (!res.ok) throw new Error('unauthorized');
    const d = await res.json();
    if (d.ok === undefined) throw new Error('unexpected response');
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    initApp();
  } catch {
    state.pwd = '';
    sessionStorage.removeItem('nx_pwd');
  }
}
