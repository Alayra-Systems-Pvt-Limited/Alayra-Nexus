// Shared mutable dashboard state.
//
// A plain object rather than exported `let` bindings: an ES module's imported
// bindings are read-only for the importer, so `modelRegistry = [...]` from another
// file would be a TypeError. Reading and writing `state.modelRegistry` works from
// anywhere and keeps a single source of truth.
export const state = {
  /** Admin password for the session. Empty until sign-in; `demo` in demo mode. */
  pwd:           sessionStorage.getItem('nx_pwd') || '',
  teamKeys:      [],
  modelRegistry: [],
};

/** Drop the session and reload to the login screen. */
export function logout() {
  sessionStorage.removeItem('nx_pwd');
  location.reload();
}
