// Models tab — the model registry: tiers, capabilities, pricing.
import { GET, PUT } from '../api.js';
import { esc, toast, fmtNum, openModal, closeModal } from '../utils.js';
import { PROVIDER_LABELS } from '../providers.js';
import { state } from '../state.js';

const MODEL_CAPS = ['isPrimary','isFallback','hasVision','hasFIM','hasToolCalling'];
const CAP_LABELS = { isPrimary:'Primary', isFallback:'Fallback', hasVision:'Vision', hasFIM:'FIM', hasToolCalling:'Tools' };
const TIER_MAP = { premium:'badge-yellow', standard:'badge-purple', fast:'badge-green' };
const STATUS_COLORS = { active:'var(--green)', paused:'var(--yellow)', retired:'var(--muted)' };

async function loadModels() {
  if (window._demoMode) return;
  const el = document.getElementById('models-list');
  try {
    const { models } = await GET('/admin/models');
    state.modelRegistry = Array.isArray(models) ? models : [];
    if (!state.modelRegistry.length) {
      el.innerHTML = `<div class="empty-state"><div class="icon">🧠</div><p>No models in registry yet.<br/>Add models to define capabilities and routing priority.</p></div>`;
      return;
    }
    const sorted = [...state.modelRegistry].sort((a,b) => (a.priority||99)-(b.priority||99));
    el.innerHTML = sorted.map(m => renderModelCard(m)).join('');
  } catch(e) { el.innerHTML = `<div style="color:var(--red)">${e.message}</div>`; }
}

// Escape user-controlled values before they are inserted via innerHTML, so a
// model/provider name containing markup cannot execute as HTML/script.


function renderModelCard(m) {
  const statusColor = STATUS_COLORS[m.status] || 'var(--muted)';
  const cost = (m.inputCostPer1M || m.outputCostPer1M)
    ? `<span style="font-size:11px;color:var(--muted)">$${(m.inputCostPer1M||0).toFixed(2)} / $${(m.outputCostPer1M||0).toFixed(2)} per 1M</span>`
    : '';
  return `<div class="model-card">
    <div class="model-card-info">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
        <span class="model-name">${esc(m.displayName||m.modelString)}</span>
        <span class="badge ${TIER_MAP[m.tier]||'badge-gray'}" style="text-transform:capitalize">${esc(m.tier||'standard')}</span>
        <span style="font-size:12px;font-weight:500;color:${statusColor}">${esc(m.status||'active')}</span>
        ${m.priority!=null?`<span style="font-size:11px;color:var(--subtle)">Priority ${esc(m.priority)}</span>`:''}
      </div>
      <div class="model-string">${esc(m.modelString)}</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="model-caps">
          ${MODEL_CAPS.map(c=>`<span class="cap-badge ${m[c]?'active':''}">${CAP_LABELS[c]}</span>`).join('')}
        </div>
        ${cost}
        ${m.contextWindow?`<span style="font-size:11px;color:var(--muted)">${fmtNum(m.contextWindow)} ctx</span>`:''}
      </div>
    </div>
    <div class="model-card-actions">
      <button class="btn-icon btn-sm" onclick="showEditModel('${m.id}')">Edit</button>
      ${m.status==='active'
        ? `<button class="btn-warning btn-sm" onclick="setModelStatus('${m.id}','paused')">Pause</button>`
        : m.status==='paused'
          ? `<button class="btn-secondary btn-sm" onclick="setModelStatus('${m.id}','active')">Activate</button>`
          : ''}
      <button class="btn-danger btn-sm" onclick="deleteModel('${m.id}')">Delete</button>
    </div>
  </div>`;
}

function showAddModel() {
  document.getElementById('modal-box').innerHTML = buildModelForm(null);
  openModal();
}

async function showEditModel(id) {
  const m = state.modelRegistry.find(x => x.id === id);
  if (!m) return;
  document.getElementById('modal-box').innerHTML = buildModelForm(m);
  openModal();
}

function buildModelForm(m) {
  const isNew = !m;
  const caps = MODEL_CAPS.map(c =>
    `<label class="cap-toggle ${m&&m[c]?'on':''}" onclick="this.classList.toggle('on')">
      <input type="checkbox" id="cap-${c}" ${m&&m[c]?'checked':''}/>${CAP_LABELS[c]}
    </label>`
  ).join('');
  return `
    <button class="modal-close" onclick="closeModal()">×</button>
    <div class="modal-title">${isNew?'Add model':'Edit — '+esc(m.displayName||m.modelString)}</div>
    <div class="form-row">
      <label class="form-label">Display name</label>
      <input id="m-display-name" value="${m?esc(m.displayName||''):''}" placeholder="e.g. Claude 3.5 Sonnet"/>
    </div>
    <div class="form-row">
      <label class="form-label">Model string (actual API ID)</label>
      <input id="m-model-string" value="${m?esc(m.modelString||''):''}" placeholder="e.g. claude-3-5-sonnet-20241022"/>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Provider</label>
        <select id="m-provider">
          ${['anthropic','openai','google','groq','openrouter','custom'].map(p=>`<option value="${p}" ${m&&m.provider===p?'selected':''}>${PROVIDER_LABELS[p]||p}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label class="form-label">Tier</label>
        <select id="m-tier">
          <option value="premium" ${m&&m.tier==='premium'?'selected':''}>Premium</option>
          <option value="standard" ${!m||m.tier==='standard'?'selected':''}>Standard</option>
          <option value="fast" ${m&&m.tier==='fast'?'selected':''}>Fast</option>
        </select>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Status</label>
        <select id="m-status">
          <option value="active" ${!m||m.status==='active'?'selected':''}>Active</option>
          <option value="paused" ${m&&m.status==='paused'?'selected':''}>Paused</option>
          <option value="retired" ${m&&m.status==='retired'?'selected':''}>Retired</option>
        </select>
      </div>
      <div class="form-row">
        <label class="form-label">Priority (lower = first)</label>
        <input id="m-priority" type="number" value="${m?m.priority||1:1}" min="1"/>
      </div>
    </div>
    <div class="form-row">
      <label class="form-label">Capabilities</label>
      <div class="cap-toggle-row">${caps}</div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Input cost ($ per 1M tokens)</label>
        <input id="m-input-cost" type="number" step="0.01" value="${m?m.inputCostPer1M||0:0}" min="0"/>
      </div>
      <div class="form-row">
        <label class="form-label">Output cost ($ per 1M tokens)</label>
        <input id="m-output-cost" type="number" step="0.01" value="${m?m.outputCostPer1M||0:0}" min="0"/>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label class="form-label">Context window</label>
        <input id="m-ctx" type="number" value="${m?m.contextWindow||0:0}" min="0"/>
      </div>
      <div class="form-row">
        <label class="form-label">Max output tokens</label>
        <input id="m-max-tokens" type="number" value="${m?m.maxTokens||0:0}" min="0"/>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="submitModel('${m?m.id:''}')">Save</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>`;
}

async function submitModel(existingId) {
  const id = existingId || crypto.randomUUID();
  const model = {
    id,
    displayName:     document.getElementById('m-display-name').value.trim(),
    modelString:     document.getElementById('m-model-string').value.trim(),
    provider:        document.getElementById('m-provider').value,
    tier:            document.getElementById('m-tier').value,
    status:          document.getElementById('m-status').value,
    priority:        parseInt(document.getElementById('m-priority').value) || 1,
    isPrimary:       document.getElementById('cap-isPrimary').checked,
    isFallback:      document.getElementById('cap-isFallback').checked,
    hasVision:       document.getElementById('cap-hasVision').checked,
    hasFIM:          document.getElementById('cap-hasFIM').checked,
    hasToolCalling:  document.getElementById('cap-hasToolCalling').checked,
    inputCostPer1M:  parseFloat(document.getElementById('m-input-cost').value) || 0,
    outputCostPer1M: parseFloat(document.getElementById('m-output-cost').value) || 0,
    contextWindow:   parseInt(document.getElementById('m-ctx').value) || 0,
    maxTokens:       parseInt(document.getElementById('m-max-tokens').value) || 0,
  };
  if (!model.modelString) { toast('Model string is required', true); return; }
  if (existingId) {
    state.modelRegistry = state.modelRegistry.map(m => m.id === existingId ? model : m);
  } else {
    state.modelRegistry = [...state.modelRegistry, model];
  }
  try {
    await PUT('/admin/models', { models: state.modelRegistry });
    toast(existingId ? 'Model updated' : 'Model added');
    closeModal(); loadModels();
  } catch(e) { toast(e.message, true); }
}

// The registry is mutated optimistically for a snappy UI, but a failed PUT must
// roll it back — otherwise the next save ships the local (rejected) state.
async function setModelStatus(id, status) {
  const previous = state.modelRegistry;
  state.modelRegistry = state.modelRegistry.map(m => m.id === id ? {...m, status} : m);
  try {
    await PUT('/admin/models', { models: state.modelRegistry });
    toast(`Model ${status}`); loadModels();
  } catch(e) { state.modelRegistry = previous; toast(e.message, true); }
}

async function deleteModel(id) {
  if (!confirm('Delete this model from the registry?')) return;
  const previous = state.modelRegistry;
  state.modelRegistry = state.modelRegistry.filter(m => m.id !== id);
  try {
    await PUT('/admin/models', { models: state.modelRegistry });
    toast('Model deleted'); loadModels();
  } catch(e) { state.modelRegistry = previous; toast(e.message, true); }
}


export {
  loadModels, renderModelCard, showAddModel, showEditModel, buildModelForm,
  submitModel, setModelStatus, deleteModel,
};
