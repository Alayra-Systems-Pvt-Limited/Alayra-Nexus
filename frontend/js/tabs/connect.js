// Connect tab — base URL, model id, API key, and live routing status.
import { GET } from '../api.js';
import { esc } from '../utils.js';

async function loadConnect() {
  if (window._demoMode) return;
  try {
    const cfg = await GET('/admin/config');
    const key = cfg.nexusApiKey || '';
    const masked = key.slice(0,8) + '••••••••' + key.slice(-4);
    document.getElementById('connect-rows').innerHTML = `
      <div class="copy-row"><span class="copy-label">Base URL</span><span class="copy-val">${esc(cfg.baseUrl)}</span><button class="copy-btn" data-copy="${esc(cfg.baseUrl)}">Copy</button></div>
      <div class="copy-row"><span class="copy-label">Model</span><span class="copy-val">alayra-nexus-1</span><button class="copy-btn" data-copy="alayra-nexus-1">Copy</button></div>
      <div class="copy-row"><span class="copy-label">API Key</span><span class="copy-val">${esc(masked)}</span><button class="copy-btn" data-copy="${esc(key)}">Copy</button></div>`;
    loadRoutingStatus();
  } catch(e) { document.getElementById('connect-rows').innerHTML = `<div style="color:var(--red);font-size:13px">${esc(e.message)}</div>`; }
}

async function loadRoutingStatus() {
  try {
    const data = await GET('/admin/routing/status');
    const el = document.getElementById('routing-status');
    const tierColor = { premium:'var(--yellow)', standard:'var(--accent)', fast:'var(--green)' };
    el.innerHTML = data.tiers.map(t => {
      if (!t.providers.length) return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span class="badge badge-gray" style="text-transform:capitalize">${t.tier}</span><span style="color:var(--subtle);font-size:12px">No providers</span></div>`;
      return t.providers.map(p => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <span class="badge" style="background:${tierColor[t.tier]}22;color:${tierColor[t.tier]};text-transform:capitalize">${t.tier}</span>
          <span>${p.name||p.id}</span>
          ${p.preferredModel?`<span style="font-family:monospace;font-size:12px;color:var(--muted)">${p.preferredModel}</span>`:''}
          <span class="badge ${p.activeKeys>0?'badge-green':'badge-red'}">${p.activeKeys} active</span>
        </div>`).join('');
    }).join('');
  } catch { document.getElementById('routing-status').textContent = 'Could not load'; }
}


export { loadConnect, loadRoutingStatus };
