// Admin API client. Every call carries the session's bearer token; a 401 means the
// password was rotated or revoked, so the session is dropped rather than retried.
import { state, logout } from './state.js';

async function api(method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(t || `HTTP ${res.status}`); }
  return res.json();
}

export const GET   = p      => api('GET',    p);
export const POST  = (p, b) => api('POST',   p, b);
export const PUT   = (p, b) => api('PUT',    p, b);
export const DEL   = p      => api('DELETE', p);
export const PATCH = (p, b) => api('PATCH',  p, b);
