// Team tab — scoped access keys issued to teams.
import { GET, POST, DEL } from '../api.js';
import { esc, toast, copyText, openModal, closeModal } from '../utils.js';
import { state } from '../state.js';

async function loadTeamKeys() {
  try { const data = await GET('/admin/team-keys'); state.teamKeys = data.keys || []; }
  catch { state.teamKeys = []; }
}

function renderTeamKeys() {
  if (window._demoMode) return;
  const el = document.getElementById('team-list');
  if (!state.teamKeys.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">👥</div><p>No team keys yet.<br/>Create keys for each team member.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Key (masked)</th><th>Created</th><th>Actions</th></tr></thead>
    <tbody>${state.teamKeys.map(k=>`<tr>
      <td><strong>${esc(k.name)}</strong></td>
      <td><span style="font-family:monospace;font-size:12px">${esc(k.maskedKey)}</span></td>
      <td style="color:var(--muted)">${new Date(k.createdAt).toLocaleDateString()}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-icon btn-sm" data-id="${esc(k.id)}" onclick="copyTeamKey(this.dataset.id)">Copy key</button>
        <button class="btn-danger btn-sm" data-id="${esc(k.id)}" data-name="${esc(k.name)}" onclick="revokeTeamKey(this.dataset.id, this.dataset.name)">Revoke</button>
      </div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function showCreateTeamKey() {
  document.getElementById('modal-box').innerHTML = `
    <button class="modal-close" onclick="closeModal()">×</button>
    <div class="modal-title">Create team key</div>
    <div class="form-row">
      <label class="form-label">Name</label>
      <input id="tk-name" placeholder="e.g. Abbas, Frontend Team"/>
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="submitCreateTeamKey()">Create key</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>`;
  openModal();
}

async function submitCreateTeamKey() {
  const name = document.getElementById('tk-name').value.trim();
  if (!name) { toast('Name is required', true); return; }
  try {
    const r = await POST('/admin/team-keys', { name });
    closeModal(); state.teamKeys = [...state.teamKeys, r.key]; renderTeamKeys();
    toast(`Key for "${name}" created — copy it now`);
    showFullKeyModal(r.key.name, r.key.plainKey);
  } catch(e) { toast(e.message, true); }
}

function showFullKeyModal(name, key) {
  document.getElementById('modal-box').innerHTML = `
    <div class="modal-title">Key for ${esc(name)}</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px">Copy this key now. It won't be shown again.</p>
    <div class="copy-row"><span class="copy-val" style="font-family:monospace">${esc(key)}</span><button class="copy-btn" data-copy="${esc(key)}">Copy</button></div>
    <div class="form-actions" style="margin-top:12px"><button class="btn-primary" onclick="closeModal()">Done</button></div>`;
  openModal();
}

async function copyTeamKey(id) {
  try { const r = await GET(`/admin/team-keys/${id}/reveal`); copyText(r.key); toast('Key copied'); }
  catch { toast('Cannot re-reveal key for security', true); }
}

async function revokeTeamKey(id, name) {
  if (!confirm(`Revoke key for "${name}"?`)) return;
  try { await DEL(`/admin/team-keys/${id}`); state.teamKeys = state.teamKeys.filter(k=>k.id!==id); renderTeamKeys(); toast('Key revoked'); }
  catch(e) { toast(e.message, true); }
}


export {
  loadTeamKeys, renderTeamKeys, showCreateTeamKey, submitCreateTeamKey,
  showFullKeyModal, copyTeamKey, revokeTeamKey,
};
