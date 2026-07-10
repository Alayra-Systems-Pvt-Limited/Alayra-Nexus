// Settings tab — API key, SSRF policy, guardrails, cost routing, response cache.
import { GET, PUT, POST } from '../api.js';
import { toast } from '../utils.js';
import { loadConnect } from './connect.js';

async function loadSettings() {
  if (window._demoMode) return;
  try {
    const cfg = await GET('/admin/config');
    document.getElementById('settings-key-raw').value = cfg.nexusApiKey || '';
    document.getElementById('settings-key').textContent = (cfg.nexusApiKey||'').slice(0,8)+'••••••••';
  } catch {}
  try {
    const ssrf = await GET('/admin/settings/ssrf');
    document.getElementById('ssrf-allow-private').checked = !!ssrf.allowPrivate;
    document.getElementById('ssrf-allowlist').value = (ssrf.allowList||[]).join('\n');
    const env = ssrf.envAllowList||[];
    document.getElementById('ssrf-env-hint').textContent = env.length
      ? 'Also allowed via environment (read-only): ' + env.join(', ')
      : '';
  } catch {}
  loadGuardrails();
  loadRouting();
  loadCache();
}

async function saveSsrf() {
  const allowPrivate = document.getElementById('ssrf-allow-private').checked;
  const allowList = document.getElementById('ssrf-allowlist').value
    .split('\n').map(s => s.trim()).filter(Boolean);
  try {
    await PUT('/admin/settings/ssrf', { allowPrivate, allowList });
    toast('Network settings saved');
    loadSettings();
  } catch(e) { toast(e.message, true); }
}

async function loadGuardrails() {
  if (window._demoMode) return;
  try {
    const gr = await GET('/admin/settings/guardrails');
    document.getElementById('gr-enabled').checked = !!gr.enabled;
    document.getElementById('gr-buffered').checked = !!gr.bufferedSafe;
    document.getElementById('gr-rules').value = JSON.stringify(gr.rules || [], null, 2);
  } catch {}
}

async function saveGuardrails() {
  const enabled = document.getElementById('gr-enabled').checked;
  const bufferedSafe = document.getElementById('gr-buffered').checked;
  const raw = document.getElementById('gr-rules').value.trim();
  let rules;
  try { rules = raw ? JSON.parse(raw) : []; }
  catch { toast('Rules must be valid JSON', true); return; }
  if (!Array.isArray(rules)) { toast('Rules must be a JSON array', true); return; }
  try {
    await PUT('/admin/settings/guardrails', { enabled, bufferedSafe, rules });
    toast('Guardrails saved');
    loadGuardrails();
  } catch(e) { toast(e.message, true); }
}

async function loadRouting() {
  if (window._demoMode) return;
  try {
    const r = await GET('/admin/settings/routing');
    const w = String(r.costWeight ?? 0);
    document.getElementById('cw-range').value = w;
    document.getElementById('cw-val').textContent = w;
  } catch {}
}

async function saveRouting() {
  const costWeight = parseFloat(document.getElementById('cw-range').value);
  try {
    await PUT('/admin/settings/routing', { costWeight });
    toast('Routing saved');
    loadRouting();
  } catch(e) { toast(e.message, true); }
}

async function loadCache() {
  if (window._demoMode) return;
  try {
    const c = await GET('/admin/settings/cache');
    document.getElementById('cache-enabled').checked = !!c.enabled;
    document.getElementById('cache-ttl').value = c.ttlSeconds ?? 3600;
  } catch {}
}

async function saveCache() {
  const enabled = document.getElementById('cache-enabled').checked;
  const ttlSeconds = parseInt(document.getElementById('cache-ttl').value, 10) || 3600;
  try {
    await PUT('/admin/settings/cache', { enabled, ttlSeconds });
    toast('Cache settings saved');
    loadCache();
  } catch(e) { toast(e.message, true); }
}

let keyVisible = false;
function toggleShowKey() {
  keyVisible = !keyVisible;
  const raw = document.getElementById('settings-key-raw').value;
  document.getElementById('settings-key').textContent = keyVisible ? raw : raw.slice(0,8)+'••••••••';
  document.getElementById('show-key-btn').textContent = keyVisible ? 'Hide' : 'Show';
}

async function rotateKey() {
  if (!confirm('Rotate the Nexus API key? All existing sessions will stop working.')) return;
  try {
    const r = await POST('/admin/api-key/regenerate');
    document.getElementById('settings-key-raw').value = r.key;
    document.getElementById('settings-key').textContent = r.key.slice(0,8)+'••••••••';
    keyVisible = false; toast('Key rotated'); loadConnect();
  } catch(e) { toast(e.message, true); }
}


export {
  loadSettings, saveSsrf, loadGuardrails, saveGuardrails, loadRouting, saveRouting,
  loadCache, saveCache, toggleShowKey, rotateKey,
};
