// Pools tab (Nexus) — provider cards, key tables, and the add/edit modals.
import { GET, POST, DEL, PATCH } from '../api.js';
import { esc, toast, openModal, closeModal } from '../utils.js';
import { loadConnect } from './connect.js';
import { PROVIDER_COLORS, PROVIDER_LABELS } from '../providers.js';

async function loadNexus() {
  if (window._demoMode) return;
  const listEl = document.getElementById('nexus-list');
  const sumEl  = document.getElementById('nexus-summary');
  listEl.innerHTML = '<div style="text-align:center;padding:2rem"><div class="loader"></div></div>';
  try {
    const [{ providers }, summary] = await Promise.all([
      GET('/admin/providers'),
      GET('/admin/nexus/summary'),
    ]);

    // Summary stats
    sumEl.innerHTML = `<div class="grid-4">
      <div class="stat"><div class="stat-label">Pools</div><div class="stat-value">${summary.providers}</div></div>
      <div class="stat"><div class="stat-label">Active keys</div><div class="stat-value" style="color:var(--green)">${summary.active}</div></div>
      <div class="stat"><div class="stat-label">Cooling</div><div class="stat-value" style="color:var(--yellow)">${summary.cooling}</div></div>
      <div class="stat"><div class="stat-label">Banned</div><div class="stat-value" style="color:var(--red)">${summary.banned}</div></div>
    </div>`;

    if (!providers.length) {
      listEl.innerHTML = `<div class="empty-state"><div class="icon">⚡</div><p>No provider pools yet.<br/>Add your first pool to start routing.</p></div>`;
      return;
    }

    listEl.innerHTML = providers.map(p => renderProviderCard(p)).join('');
    providers.forEach(p => loadKeysForProvider(p.id));
  } catch(e) { listEl.innerHTML = `<div style="color:var(--red)">${esc(e.message)}</div>`; }
}


function tierBadge(tier) {
  const map = { premium:'badge-yellow', standard:'badge-purple', fast:'badge-green' };
  return `<span class="badge ${map[tier]||'badge-gray'}" style="text-transform:capitalize">${esc(tier || '')}</span>`;
}

// Provider ids and names reach the DOM through `data-` attributes, never through an
// inline handler's argument list.
//
// `esc()` is HTML escaping, and HTML escaping does not protect a JavaScript string
// context: the browser HTML-decodes an attribute *before* parsing its contents as
// code, so `esc("O'Reilly")` becomes `O&#39;Reilly`, decodes back to `O'Reilly`, and
// closes the string literal in `onclick="deleteProvider('...')"`. A `data-` attribute
// is never parsed as code, so the value stays inert whatever it contains.
function renderProviderCard(p) {
  const dot  = PROVIDER_COLORS[p.provider] || 'provider-dot-custom';
  const lbl  = PROVIDER_LABELS[p.provider] || p.provider;
  const id   = esc(p.id);
  const name = esc(p.name || '');
  return `<div class="provider-card" id="pcard-${id}">
    <div class="provider-card-header" data-pool-action="toggle" data-pool-id="${id}">
      <div class="provider-dot ${dot}"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-weight:600;font-size:14px">${name}</span>
          <span class="badge badge-gray" style="font-size:10px">${esc(lbl || '')}</span>
          ${tierBadge(p.tier)}
        </div>
        <div style="font-family:monospace;font-size:12px;color:var(--muted)">
          ${p.preferredModel ? esc(p.preferredModel) : 'Models managed in the Models tab'}
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn-icon btn-sm" data-pool-action="add-key" data-pool-id="${id}" data-pool-name="${name}">+ Key</button>
        <button class="btn-icon btn-sm" data-pool-action="edit" data-pool-id="${id}">Edit</button>
        <button class="btn-danger btn-sm" data-pool-action="delete" data-pool-id="${id}" data-pool-name="${name}">Delete</button>
      </div>
    </div>
    <div class="provider-card-body" id="pbody-${id}">
      <div id="keys-${id}"><div class="loader"></div></div>
    </div>
  </div>`;
}

// One delegated listener serves every provider card, present and future. A click on
// an action button must not also collapse the card behind it, so the header toggles
// only when the click did not land on a button.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-pool-action]');
  if (!el) return;
  const { poolAction, poolId, poolName } = el.dataset;
  if (poolAction === 'toggle')  { if (!e.target.closest('button')) toggleProviderBody(poolId); return; }
  if (poolAction === 'add-key') return showAddKey(poolId, poolName);
  if (poolAction === 'edit')    return showEditProvider(poolId);
  if (poolAction === 'delete')  return deleteProvider(poolId, poolName);
});

function toggleProviderBody(id) {
  const body = document.getElementById('pbody-'+id);
  body.style.display = body.style.display === 'none' ? '' : 'none';
}

async function loadKeysForProvider(providerId) {
  const el = document.getElementById('keys-'+providerId);
  if (!el) return;
  try {
    const { keys } = await GET(`/admin/providers/${providerId}/keys`);
    if (!keys.length) {
      el.innerHTML = `<div style="font-size:12px;color:var(--subtle)">No keys — click "+ Key" to add one</div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Label / Key</th><th>Owner</th><th>Status</th><th>RPM</th><th>Actions</th></tr></thead>
      <tbody>${keys.map(k => `<tr id="krow-${k.id}">
        <td>
          <div style="font-family:monospace;font-size:12px">${esc(k.maskedKey)}</div>
          ${k.label?`<div style="font-size:11px;color:var(--muted)">${esc(k.label)}</div>`:''}
        </td>
        <td>${k.ownerTeamName
          ? `<span class="badge badge-blue" title="Private to this team (BYOK)">${esc(k.ownerTeamName)}</span>`
          : `<span style="font-size:12px;color:var(--muted)">Shared pool</span>`}</td>
        <td>${keyStatusBadge(k)}</td>
        <td><div class="meter-row" id="meter-${k.id}">
          <div class="meter-bar"><div class="meter-fill meter-fill-green" style="width:0%" id="meter-fill-${k.id}"></div></div>
          <span class="meter-label" id="meter-label-${k.id}">0/${k.rpmLimit}</span>
        </div></td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn-icon btn-sm" onclick="testProvKey('${k.id}',this)">Test</button>
            ${k.status==='banned'
              ? `<button class="btn-secondary btn-sm" onclick="unbanKey('${k.id}','${providerId}')">Unban</button>`
              : `<button class="btn-warning btn-sm" onclick="banKey('${k.id}','${providerId}')">Ban</button>`}
            <button class="btn-danger btn-sm" onclick="deleteKey('${k.id}','${providerId}')">✕</button>
          </div>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`;
    keys.forEach(k => pollKeyMetrics(k.id, k.rpmLimit));
  } catch(e) { el.innerHTML = `<div style="color:var(--red);font-size:12px">${esc(e.message)}</div>`; }
}

function keyStatusBadge(k) {
  if (k.status==='banned')  return '<span class="badge badge-red">Banned</span>';
  if (k.status==='cooling') return '<span class="badge badge-yellow">Cooling</span>';
  return '<span class="badge badge-green">Active</span>';
}

async function pollKeyMetrics(keyId, rpmLimit) {
  try {
    const m = await GET(`/admin/keys/${keyId}/metrics`);
    const fill = document.getElementById('meter-fill-'+keyId);
    const label = document.getElementById('meter-label-'+keyId);
    if (!fill || !label) return;
    const pct = rpmLimit > 0 ? Math.min(100, Math.round(m.rpm / rpmLimit * 100)) : 0;
    fill.style.width = pct + '%';
    fill.className = 'meter-fill ' + (pct >= 85 ? 'meter-fill-red' : pct >= 60 ? 'meter-fill-yellow' : 'meter-fill-green');
    label.textContent = `${m.rpm}/${rpmLimit}`;
  } catch {}
}

async function deleteProvider(id, name) {
  if (!confirm(`Delete pool "${name}" and all its keys?`)) return;
  try { await DEL(`/admin/providers/${id}`); toast('Pool deleted'); loadNexus(); }
  catch(e) { toast(e.message, true); }
}

async function deleteKey(id, providerId) {
  try { await DEL(`/admin/keys/${id}`); toast('Key removed'); loadKeysForProvider(providerId); }
  catch(e) { toast(e.message, true); }
}

async function banKey(id, providerId) {
  try { await POST(`/admin/keys/${id}/ban`); toast('Key banned'); loadKeysForProvider(providerId); }
  catch(e) { toast(e.message, true); }
}

async function unbanKey(id, providerId) {
  try { await POST(`/admin/keys/${id}/unban`); toast('Key unbanned'); loadKeysForProvider(providerId); }
  catch(e) { toast(e.message, true); }
}

async function testProvKey(id, btn) {
  const orig = btn.textContent;
  btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await POST(`/admin/keys/${id}/test`);
    btn.textContent = r.success ? `✓ ${r.latencyMs}ms` : '✗ fail';
    btn.style.color = r.success ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { btn.textContent=orig; btn.style.color=''; btn.disabled=false; }, 3000);
  } catch {
    btn.textContent='err'; btn.style.color='var(--red)';
    setTimeout(() => { btn.textContent=orig; btn.style.color=''; btn.disabled=false; }, 3000);
  }
}


// ── Add provider modal ──────────────────────────────────────────────
const PROVIDER_DEFAULTS = {
  anthropic:  { name:'Anthropic',  model:'claude-3-5-sonnet-20241022',   tier:'premium',  baseUrl:'https://api.anthropic.com/v1',                           rpm:60,  tpm:100000 },
  openai:     { name:'OpenAI',     model:'gpt-4o-mini',                  tier:'standard', baseUrl:'https://api.openai.com/v1',                              rpm:60,  tpm:100000 },
  google:     { name:'Google',     model:'gemini-2.0-flash',             tier:'standard', baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai', rpm:60,  tpm:100000 },
  groq:       { name:'Groq',       model:'llama-3.3-70b-versatile',      tier:'fast',     baseUrl:'https://api.groq.com/openai/v1',                         rpm:30,  tpm:6000   },
  openrouter: { name:'OpenRouter', model:'openai/gpt-4o-mini',           tier:'standard', baseUrl:'https://openrouter.ai/api/v1',                           rpm:60,  tpm:100000 },
  custom:     { name:'Custom',     model:'',                             tier:'standard', baseUrl:'',                                                       rpm:60,  tpm:100000 },
};

function showAddProvider() {
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" onclick="closeModal()">×</button>
    <div class="modal-title">Add provider pool</div>
    <div class="form-row">
      <label class="form-label">Provider type</label>
      <select id="prov-type" onchange="fillProviderDefaults()">
        <option value="anthropic">Anthropic (Claude)</option>
        <option value="openai">OpenAI (GPT)</option>
        <option value="google">Google (Gemini)</option>
        <option value="groq">Groq</option>
        <option value="openrouter">OpenRouter</option>
        <option value="custom">Custom</option>
      </select>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Display name</label>
        <input id="prov-name" placeholder="e.g. Anthropic Primary"/>
      </div>
      <div class="form-row">
        <label class="form-label">Tier</label>
        <select id="prov-tier">
          <option value="premium">Premium (tried first)</option>
          <option value="standard" selected>Standard</option>
          <option value="fast">Fast (fallback)</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <label class="form-label">Default model <span style="color:var(--subtle)">(optional)</span></label>
      <input id="prov-model" placeholder="e.g. claude-3-5-sonnet-20241022"/>
      <div class="form-hint">Optional. Models are now managed in the Models tab; this seeds one on first run and is otherwise unused.</div>
    </div>
    <div class="form-row">
      <label class="form-label">Base URL</label>
      <input id="prov-base-url" placeholder="https://api.anthropic.com/v1"/>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Auth header</label>
        <input id="prov-auth-header" value="Authorization"/>
      </div>
      <div class="form-row">
        <label class="form-label">Auth prefix</label>
        <input id="prov-auth-prefix" placeholder="Bearer (default)"/>
      </div>
    </div>
    <div style="border-top:1px solid var(--border);margin:12px 0 16px;padding-top:14px">
      <div class="card-title">First API key</div>
      <div class="form-row">
        <label class="form-label">API key</label>
        <input id="prov-key" type="password" placeholder="sk-ant-... or AIza... or sk-..."/>
      </div>
      <div class="form-row">
        <label class="form-label">Key label (optional)</label>
        <input id="prov-key-label" placeholder="e.g. Primary, Work, Key 1"/>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">RPM limit</label>
          <input id="prov-rpm" type="number" value="60" min="1"/>
        </div>
        <div class="form-row">
          <label class="form-label">TPM limit</label>
          <input id="prov-tpm" type="number" value="100000" min="1"/>
        </div>
      </div>
    </div>
    <div class="val-row" id="prov-val-status"></div>
    <div class="form-actions">
      <button class="btn-primary" onclick="submitAddProvider()">Add pool</button>
      <button class="btn-secondary" onclick="testNewProvider()">Test credentials</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>`;
  openModal();
  fillProviderDefaults();
}

function fillProviderDefaults() {
  const type = document.getElementById('prov-type').value;
  const d = PROVIDER_DEFAULTS[type] || PROVIDER_DEFAULTS.custom;
  const nameEl = document.getElementById('prov-name');
  if (!nameEl.value || Object.values(PROVIDER_DEFAULTS).some(x => x.name === nameEl.value)) nameEl.value = d.name;
  if (!document.getElementById('prov-model').value) document.getElementById('prov-model').value = d.model;
  document.getElementById('prov-tier').value = d.tier;
  document.getElementById('prov-base-url').value = d.baseUrl;
  document.getElementById('prov-rpm').value = d.rpm;
  document.getElementById('prov-tpm').value = d.tpm;
}

async function testNewProvider() {
  const type = document.getElementById('prov-type').value;
  const key  = document.getElementById('prov-key').value.trim();
  const baseUrl = document.getElementById('prov-base-url').value.trim();
  const authHeader = document.getElementById('prov-auth-header').value.trim() || 'Authorization';
  const authPrefix = document.getElementById('prov-auth-prefix').value.trim() || null;
  const el = document.getElementById('prov-val-status');
  if (!key) { el.innerHTML = '<span class="val-status val-err">Enter an API key first</span>'; return; }
  el.innerHTML = '<span class="val-status val-testing"><span class="loader"></span> Testing…</span>';
  try {
    const r = await POST('/admin/validate/provider', { provider: type, baseUrl: baseUrl||null, apiKey: key, authHeader, authPrefix });
    el.innerHTML = r.ok
      ? `<span class="val-status val-ok">✓ Connected (${r.latencyMs}ms)</span>`
      : `<span class="val-status val-err">✗ ${r.error}</span>`;
  } catch(e) { el.innerHTML = `<span class="val-status val-err">✗ ${esc(e.message)}</span>`; }
}

async function submitAddProvider() {
  const type       = document.getElementById('prov-type').value;
  const name       = document.getElementById('prov-name').value.trim();
  const key        = document.getElementById('prov-key').value.trim();
  const keyLabel   = document.getElementById('prov-key-label').value.trim();
  const model      = document.getElementById('prov-model').value.trim();
  const tier       = document.getElementById('prov-tier').value;
  const baseUrl    = document.getElementById('prov-base-url').value.trim();
  const authHeader = document.getElementById('prov-auth-header').value.trim() || 'Authorization';
  const authPrefix = document.getElementById('prov-auth-prefix').value.trim() || undefined;
  const rpm        = parseInt(document.getElementById('prov-rpm').value) || 60;
  const tpm        = parseInt(document.getElementById('prov-tpm').value) || 100000;
  if (!name || !key) { toast('Name and API key are required', true); return; }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '-' + Date.now().toString(36);
  try {
    const prov = await POST('/admin/providers', { name, slug, provider: type, tier, preferredModel: model||undefined, baseUrl: baseUrl||undefined, authHeader, authPrefix });
    await POST(`/admin/providers/${prov.provider.id}/keys`, { apiKey: key, label: keyLabel||undefined, rpmLimit: rpm, tpmLimit: tpm });
    if (model) {
      const vr = await POST('/admin/validate/model', { providerId: prov.provider.id, modelName: model });
      toast(vr.ok ? 'Pool added and model verified ✓' : `Pool added but model test failed: ${vr.error}`, !vr.ok);
    } else { toast('Pool added'); }
    closeModal(); loadNexus(); loadConnect();
  } catch(e) { toast(e.message, true); }
}

// ── Add key modal ───────────────────────────────────────────────────
async function showAddKey(providerId, providerName) {
  // BYOK: an owned key serves only its team's traffic. Teams are optional — if none
  // exist, the picker still renders and every key lands in the shared pool.
  let teams = [];
  try { teams = (await GET('/admin/teams')).teams || []; } catch { /* shared pool only */ }
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" onclick="closeModal()">×</button>
    <div class="modal-title">Add key — ${esc(providerName)}</div>
    <div class="form-row">
      <label class="form-label">API key</label>
      <input id="new-key-val" type="password" placeholder="sk-ant-... or AIza..."/>
    </div>
    <div class="form-row">
      <label class="form-label">Label (optional)</label>
      <input id="new-key-label" placeholder="e.g. Key 2, Backup, Work account"/>
    </div>
    <div class="form-row">
      <label class="form-label">Owner</label>
      <select id="new-key-owner">
        <option value="">Shared pool — any caller may route through it</option>
        ${teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)} — private (BYOK)</option>`).join('')}
      </select>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">RPM limit</label>
        <input id="new-key-rpm" type="number" value="60" min="1"/>
      </div>
      <div class="form-row">
        <label class="form-label">TPM limit</label>
        <input id="new-key-tpm" type="number" value="100000" min="1"/>
      </div>
    </div>
    <div class="val-row" id="key-val-status"></div>
    <div class="form-actions">
      <button class="btn-primary" onclick="submitAddKey('${providerId}')">Add key</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>`;
  openModal();
}

async function submitAddKey(providerId) {
  const apiKey = document.getElementById('new-key-val').value.trim();
  const label  = document.getElementById('new-key-label').value.trim();
  const owner  = document.getElementById('new-key-owner').value;
  const rpm    = parseInt(document.getElementById('new-key-rpm').value) || 60;
  const tpm    = parseInt(document.getElementById('new-key-tpm').value) || 100000;
  if (!apiKey) { toast('API key is required', true); return; }
  try {
    await POST(`/admin/providers/${providerId}/keys`, { apiKey, label: label||undefined, rpmLimit: rpm, tpmLimit: tpm, ownerTeamId: owner || null });
    toast('Key added'); closeModal(); loadKeysForProvider(providerId);
  } catch(e) { toast(e.message, true); }
}

// ── Edit provider modal ─────────────────────────────────────────────
async function showEditProvider(id) {
  const { providers } = await GET('/admin/providers');
  const p = providers.find(x => x.id === id);
  if (!p) return;
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" onclick="closeModal()">×</button>
    <div class="modal-title">Edit pool — ${esc(p.name || '')}</div>
    <div class="form-row">
      <label class="form-label">Display name</label>
      <input id="edit-name" value="${esc(p.name || '')}"/>
    </div>
    <div class="form-row">
      <label class="form-label">Default model <span style="color:var(--subtle)">(optional — models live in the Models tab)</span></label>
      <input id="edit-model" value="${esc(p.preferredModel || '')}" placeholder="e.g. claude-3-5-sonnet-20241022"/>
    </div>
    <div class="form-row">
      <label class="form-label">Tier</label>
      <select id="edit-tier">
        <option value="premium" ${p.tier==='premium'?'selected':''}>Premium</option>
        <option value="standard" ${p.tier==='standard'?'selected':''}>Standard</option>
        <option value="fast" ${p.tier==='fast'?'selected':''}>Fast</option>
      </select>
    </div>
    <div class="form-row">
      <label class="form-label">Base URL</label>
      <input id="edit-base-url" value="${esc(p.baseUrl || '')}"/>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Auth header</label>
        <input id="edit-auth-header" value="${esc(p.authHeader || 'Authorization')}"/>
      </div>
      <div class="form-row">
        <label class="form-label">Auth prefix</label>
        <input id="edit-auth-prefix" value="${esc(p.authPrefix || '')}" placeholder="Bearer"/>
      </div>
    </div>
    <div class="val-row" id="edit-val-status"></div>
    <div class="form-actions">
      <button class="btn-primary" onclick="submitEditProvider('${id}')">Save</button>
      <button class="btn-secondary" onclick="testEditModel('${id}')">Test model</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>`;
  openModal();
}

async function testEditModel(providerId) {
  const model = document.getElementById('edit-model').value.trim();
  const el = document.getElementById('edit-val-status');
  if (!model) { el.innerHTML = '<span class="val-status val-err">Enter a model name first</span>'; return; }
  el.innerHTML = '<span class="val-status val-testing"><span class="loader"></span> Testing…</span>';
  try {
    const r = await POST('/admin/validate/model', { providerId, modelName: model });
    el.innerHTML = r.ok ? `<span class="val-status val-ok">✓ (${r.latencyMs}ms)</span>` : `<span class="val-status val-err">✗ ${r.error}</span>`;
  } catch(e) { el.innerHTML = `<span class="val-status val-err">✗ ${esc(e.message)}</span>`; }
}

async function submitEditProvider(id) {
  const name       = document.getElementById('edit-name').value.trim();
  const model      = document.getElementById('edit-model').value.trim();
  const tier       = document.getElementById('edit-tier').value;
  const baseUrl    = document.getElementById('edit-base-url').value.trim();
  const authHeader = document.getElementById('edit-auth-header').value.trim() || 'Authorization';
  const authPrefix = document.getElementById('edit-auth-prefix').value.trim() || null;
  try {
    await PATCH(`/admin/providers/${id}`, { name: name||undefined, preferredModel: model||null, tier, baseUrl: baseUrl||null, authHeader, authPrefix });
    toast('Pool updated'); closeModal(); loadNexus(); loadConnect();
  } catch(e) { toast(e.message, true); }
}


export {
  loadNexus, toggleProviderBody, loadKeysForProvider, deleteProvider, deleteKey,
  banKey, unbanKey, testProvKey, showAddProvider, fillProviderDefaults,
  testNewProvider, submitAddProvider, showAddKey, submitAddKey,
  showEditProvider, testEditModel, submitEditProvider,
  // Pure render helpers, exported so their escaping can be exercised directly.
  renderProviderCard, tierBadge,
};
