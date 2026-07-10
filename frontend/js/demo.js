// Demo mode — a static, server-less preview of the dashboard.
// Every loader checks window._demoMode and returns before touching the network.
import { state } from './state.js';

function enterDemoMode() {
  state.token = 'demo'; sessionStorage.setItem('nx_token','demo');
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('status-label').textContent = '3 keys active';
  document.getElementById('status-dot').style.background = 'var(--green)';
  window._demoMode = true;

  // Connect
  document.getElementById('connect-rows').innerHTML =
    '<div class="copy-row"><span class="copy-label">Base URL</span><span class="copy-val">http://localhost:3000/v1</span><button class="copy-btn" onclick="copyText(\'http://localhost:3000/v1\',this)">Copy</button></div>' +
    '<div class="copy-row"><span class="copy-label">Model</span><span class="copy-val">alayra-nexus-1</span><button class="copy-btn" onclick="copyText(\'alayra-nexus-1\',this)">Copy</button></div>' +
    '<div class="copy-row"><span class="copy-label">API Key</span><span class="copy-val">nx_a3f9b2••••••••d2e1</span><button class="copy-btn">Copy</button></div>';
  document.getElementById('routing-status').innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="badge" style="background:var(--yellow-bg);color:var(--yellow)">Premium</span><span>Anthropic</span><span style="font-family:monospace;font-size:12px;color:var(--muted)">claude-3-5-sonnet-20241022</span><span class="badge badge-green">2 active</span></div>' +
    '<div style="display:flex;align-items:center;gap:10px"><span class="badge" style="background:var(--accent-bg);color:var(--accent)">Standard</span><span>Google</span><span style="font-family:monospace;font-size:12px;color:var(--muted)">gemini-2.0-flash</span><span class="badge badge-green">1 active</span></div>';

  // Nexus summary
  document.getElementById('nexus-summary').innerHTML =
    '<div class="grid-4"><div class="stat"><div class="stat-label">Pools</div><div class="stat-value">2</div></div><div class="stat"><div class="stat-label">Active keys</div><div class="stat-value" style="color:var(--green)">3</div></div><div class="stat"><div class="stat-label">Cooling</div><div class="stat-value" style="color:var(--yellow)">1</div></div><div class="stat"><div class="stat-label">Banned</div><div class="stat-value" style="color:var(--red)">0</div></div></div>';

  // Nexus provider cards
  document.getElementById('nexus-list').innerHTML =
    `<div class="provider-card">
      <div class="provider-card-header">
        <div class="provider-dot provider-dot-anthropic"></div>
        <div style="flex:1"><div style="display:flex;align-items:center;gap:8px"><span style="font-weight:600">Anthropic</span><span class="badge badge-gray" style="font-size:10px">Anthropic</span><span class="badge badge-yellow">premium</span></div><div style="font-family:monospace;font-size:12px;color:var(--muted)">claude-3-5-sonnet-20241022</div></div>
        <div style="display:flex;gap:6px"><button class="btn-icon btn-sm">+ Key</button><button class="btn-icon btn-sm">Edit</button><button class="btn-danger btn-sm">Delete</button></div>
      </div>
      <div class="provider-card-body">
        <div class="table-wrap"><table><thead><tr><th>Label / Key</th><th>Owner</th><th>Status</th><th>RPM</th><th>Actions</th></tr></thead><tbody>
          <tr><td><div style="font-family:monospace;font-size:12px">sk-ant-api03-••••d4f2</div><div style="font-size:11px;color:var(--muted)">Primary</div></td><td><span style="font-size:12px;color:var(--muted)">Shared pool</span></td><td><span class="badge badge-green">Active</span></td><td><div class="meter-row"><div class="meter-bar"><div class="meter-fill meter-fill-green" style="width:28%"></div></div><span class="meter-label">17/60</span></div></td><td><div style="display:flex;gap:6px"><button class="btn-icon btn-sm">Test</button><button class="btn-warning btn-sm">Ban</button><button class="btn-danger btn-sm">✕</button></div></td></tr>
          <tr><td><div style="font-family:monospace;font-size:12px">sk-ant-api03-••••a9c1</div><div style="font-size:11px;color:var(--muted)">Backup</div></td><td><span style="font-size:12px;color:var(--muted)">Shared pool</span></td><td><span class="badge badge-yellow">Cooling</span></td><td><div class="meter-row"><div class="meter-bar"><div class="meter-fill meter-fill-red" style="width:100%"></div></div><span class="meter-label">60/60</span></div></td><td><div style="display:flex;gap:6px"><button class="btn-icon btn-sm">Test</button><button class="btn-warning btn-sm">Ban</button><button class="btn-danger btn-sm">✕</button></div></td></tr>
        </tbody></table></div>
      </div>
    </div>
    <div class="provider-card">
      <div class="provider-card-header">
        <div class="provider-dot provider-dot-google"></div>
        <div style="flex:1"><div style="display:flex;align-items:center;gap:8px"><span style="font-weight:600">Google</span><span class="badge badge-gray" style="font-size:10px">Google</span><span class="badge badge-purple">standard</span></div><div style="font-family:monospace;font-size:12px;color:var(--muted)">gemini-2.0-flash</div></div>
        <div style="display:flex;gap:6px"><button class="btn-icon btn-sm">+ Key</button><button class="btn-icon btn-sm">Edit</button><button class="btn-danger btn-sm">Delete</button></div>
      </div>
      <div class="provider-card-body">
        <div class="table-wrap"><table><thead><tr><th>Label / Key</th><th>Owner</th><th>Status</th><th>RPM</th><th>Actions</th></tr></thead><tbody>
          <tr><td><div style="font-family:monospace;font-size:12px">AIzaSy••••7b3e</div><div style="font-size:11px;color:var(--muted)">Main</div></td><td><span class="badge badge-blue" title="Private to this team (BYOK)">Frontend Team</span></td><td><span class="badge badge-green">Active</span></td><td><div class="meter-row"><div class="meter-bar"><div class="meter-fill meter-fill-green" style="width:8%"></div></div><span class="meter-label">5/60</span></div></td><td><div style="display:flex;gap:6px"><button class="btn-icon btn-sm">Test</button><button class="btn-warning btn-sm">Ban</button><button class="btn-danger btn-sm">✕</button></div></td></tr>
        </tbody></table></div>
      </div>
    </div>`;

  // Models
  document.getElementById('models-list').innerHTML =
    `<div class="model-card"><div class="model-card-info"><div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span class="model-name">Claude 3.5 Sonnet</span><span class="badge badge-yellow">premium</span><span style="font-size:12px;font-weight:500;color:var(--green)">active</span><span style="font-size:11px;color:var(--subtle)">Priority 1</span></div><div class="model-string">claude-3-5-sonnet-20241022</div><div style="display:flex;align-items:center;gap:8px"><div class="model-caps"><span class="cap-badge active">Primary</span><span class="cap-badge">Fallback</span><span class="cap-badge active">Vision</span><span class="cap-badge">FIM</span><span class="cap-badge active">Tools</span></div><span style="font-size:11px;color:var(--muted)">$3.00 / $15.00 per 1M</span><span style="font-size:11px;color:var(--muted)">200K ctx</span></div></div><div class="model-card-actions"><button class="btn-icon btn-sm">Edit</button><button class="btn-warning btn-sm">Pause</button><button class="btn-danger btn-sm">Delete</button></div></div>` +
    `<div class="model-card"><div class="model-card-info"><div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span class="model-name">Gemini 2.0 Flash</span><span class="badge badge-purple">standard</span><span style="font-size:12px;font-weight:500;color:var(--green)">active</span><span style="font-size:11px;color:var(--subtle)">Priority 2</span></div><div class="model-string">gemini-2.0-flash</div><div style="display:flex;align-items:center;gap:8px"><div class="model-caps"><span class="cap-badge">Primary</span><span class="cap-badge active">Fallback</span><span class="cap-badge active">Vision</span><span class="cap-badge">FIM</span><span class="cap-badge active">Tools</span></div><span style="font-size:11px;color:var(--muted)">$0.10 / $0.40 per 1M</span><span style="font-size:11px;color:var(--muted)">1M ctx</span></div></div><div class="model-card-actions"><button class="btn-icon btn-sm">Edit</button><button class="btn-warning btn-sm">Pause</button><button class="btn-danger btn-sm">Delete</button></div></div>` +
    `<div class="model-card"><div class="model-card-info"><div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span class="model-name">Llama 3.3 70B</span><span class="badge badge-green">fast</span><span style="font-size:12px;font-weight:500;color:var(--yellow)">paused</span><span style="font-size:11px;color:var(--subtle)">Priority 3</span></div><div class="model-string">llama-3.3-70b-versatile</div><div style="display:flex;align-items:center;gap:8px"><div class="model-caps"><span class="cap-badge">Primary</span><span class="cap-badge active">Fallback</span><span class="cap-badge">Vision</span><span class="cap-badge">FIM</span><span class="cap-badge">Tools</span></div><span style="font-size:11px;color:var(--muted)">$0.00 / $0.00 per 1M</span><span style="font-size:11px;color:var(--muted)">128K ctx</span></div></div><div class="model-card-actions"><button class="btn-icon btn-sm">Edit</button><button class="btn-secondary btn-sm">Activate</button><button class="btn-danger btn-sm">Delete</button></div></div>`;

  // Team keys
  document.getElementById('team-list').innerHTML =
    '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Key (masked)</th><th>Created</th><th>Actions</th></tr></thead><tbody>' +
    '<tr><td><strong>Abbas</strong></td><td><span style="font-family:monospace;font-size:12px">nx_a3f9••••d2e1</span></td><td style="color:var(--muted)">Jul 4, 2026</td><td><div style="display:flex;gap:6px"><button class="btn-icon btn-sm">Copy key</button><button class="btn-danger btn-sm">Revoke</button></div></td></tr>' +
    '<tr><td><strong>Frontend Team</strong></td><td><span style="font-family:monospace;font-size:12px">nx_b7c2••••f4a9</span></td><td style="color:var(--muted)">Jul 4, 2026</td><td><div style="display:flex;gap:6px"><button class="btn-icon btn-sm">Copy key</button><button class="btn-danger btn-sm">Revoke</button></div></td></tr>' +
    '</tbody></table></div>';

  // Analytics — rendered on tab click via _renderDemoAnalytics()
}

export { enterDemoMode };
