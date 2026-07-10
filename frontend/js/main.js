// Dashboard entry point.
//
// Imports every section module, then boots. Loaded as `<script type="module">`, so
// it is deferred: the DOM is parsed before any of this runs.
import { state, logout }            from './state.js';
import { copyText, closeModal }     from './utils.js';
import { doLogin, restoreSession }  from './auth.js';
import { initApp, showTab }         from './app.js';
import { enterDemoMode }            from './demo.js';
import * as pools                   from './tabs/pools.js';
import * as models                  from './tabs/models.js';
import * as team                    from './tabs/team.js';
import * as analytics               from './tabs/analytics.js';
import * as settings                from './tabs/settings.js';

// ── Inline-handler bridge (temporary) ────────────────────────────────────────
// Module scope is not global, so the ~60 `onclick="fn()"` attributes still in
// index.html cannot see these functions. Publishing them on `window` keeps every
// existing handler working while the file split lands with no behaviour change.
//
// This whole block is deleted in the dashboard redesign, when inline handlers are
// replaced by delegated listeners. Nothing else should read these globals — inside
// the modules, always import directly.
Object.assign(window, {
  doLogin, doLogout: logout, enterDemoMode, showTab, copyText, closeModal,

  // Provider-card actions (toggle / add-key / edit / delete) are NOT here: they run
  // through a delegated listener in tabs/pools.js, which is where the rest of these
  // are headed as the redesign lands.
  loadNexus: pools.loadNexus,
  deleteKey: pools.deleteKey,
  banKey: pools.banKey,
  unbanKey: pools.unbanKey,
  testProvKey: pools.testProvKey,
  showAddProvider: pools.showAddProvider,
  fillProviderDefaults: pools.fillProviderDefaults,
  testNewProvider: pools.testNewProvider,
  submitAddProvider: pools.submitAddProvider,
  submitAddKey: pools.submitAddKey,
  testEditModel: pools.testEditModel,
  submitEditProvider: pools.submitEditProvider,

  showAddModel: models.showAddModel,
  showEditModel: models.showEditModel,
  submitModel: models.submitModel,
  setModelStatus: models.setModelStatus,
  deleteModel: models.deleteModel,

  showCreateTeamKey: team.showCreateTeamKey,
  submitCreateTeamKey: team.submitCreateTeamKey,
  copyTeamKey: team.copyTeamKey,
  revokeTeamKey: team.revokeTeamKey,

  loadAnalytics: analytics.loadAnalytics,
  applyCustomRange: analytics.applyCustomRange,
  sortTeamTable: analytics.sortTeamTable,
  exportAnalyticsCSV: analytics.exportAnalyticsCSV,

  saveSsrf: settings.saveSsrf,
  saveGuardrails: settings.saveGuardrails,
  saveRouting: settings.saveRouting,
  saveCache: settings.saveCache,
  toggleShowKey: settings.toggleShowKey,
  rotateKey: settings.rotateKey,
});

// ── Boot ─────────────────────────────────────────────────────────────────────
for (const id of ['login-pwd', 'login-totp']) {
  document.getElementById(id)
    .addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

if (state.token === 'demo') {
  document.getElementById('login-screen').style.display = 'none';
  enterDemoMode();
} else {
  restoreSession();
}

export { initApp };
