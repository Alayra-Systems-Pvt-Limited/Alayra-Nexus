// Shared mutable dashboard state.
//
// A plain object rather than exported `let` bindings: an ES module's imported
// bindings are read-only for the importer, so `modelRegistry = [...]` from another
// file would be a TypeError. Reading and writing `state.modelRegistry` works from
// anywhere and keeps a single source of truth.
export const state = {
  /**
   * Bearer credential for the session. A session token issued by /admin/login, or the
   * sentinel `demo`. Never the admin password — that is exchanged at login and
   * discarded, so an XSS on this page cannot lift it out of storage.
   */
  token:         sessionStorage.getItem('nx_token') || '',
  teamKeys:      [],
  modelRegistry: [],
};

/**
 * Drop the session and reload to the login screen. The token is also revoked
 * server-side, so a copy of it lifted from storage is useless afterwards; a failure
 * to reach the server must not prevent the local sign-out.
 */
export function logout() {
  const token = state.token;
  sessionStorage.removeItem('nx_token');
  state.token = '';
  const done = () => location.reload();
  if (!token || token === 'demo') return done();
  fetch('/admin/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    .catch(() => {})
    .finally(done);
}
