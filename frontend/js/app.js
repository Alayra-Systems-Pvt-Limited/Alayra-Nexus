// App shell — status polling, tab switching, and the one global click delegate.
import { GET }            from './api.js';
import { copyText }       from './utils.js';
import { loadConnect }    from './tabs/connect.js';
import { loadNexus }      from './tabs/pools.js';
import { loadModels }     from './tabs/models.js';
import { loadTeamKeys, renderTeamKeys } from './tabs/team.js';
import { loadAnalytics }  from './tabs/analytics.js';
import { loadSettings }   from './tabs/settings.js';

export async function initApp() {
  updateStatus();
  setInterval(updateStatus, 30000);
  showTab('connect');
  loadTeamKeys();
}

export async function updateStatus() {
  try {
    const s = await GET('/admin/status');
    document.getElementById('status-dot').style.background = s.ok ? 'var(--green)' : 'var(--red)';
    document.getElementById('status-label').textContent = s.ok ? `${s.activeKeys} key${s.activeKeys !== 1 ? 's' : ''} active` : 'error';
  } catch { document.getElementById('status-label').textContent = 'offline'; }
}

export function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  if (name === 'connect')   loadConnect();
  if (name === 'nexus')     loadNexus();
  if (name === 'models')    loadModels();
  if (name === 'team')      renderTeamKeys();
  if (name === 'analytics') loadAnalytics();
  if (name === 'settings')  loadSettings();
}

// Values that reach a `data-copy` attribute are never re-parsed as markup or code,
// so a base URL or key containing quotes stays inert.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn[data-copy]');
  if (btn) copyText(btn.dataset.copy, btn);
});
