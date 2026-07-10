// Analytics tab — usage charts, team leaderboard, CSV export.
// Chart.js is fetched from a CDN on first paint of this tab, not at page load.
import { GET } from '../api.js';
import { toast, fmtNum } from '../utils.js';

const CHART_PALETTE = ['#8b5cf6','#3b82f6','#22c55e','#f59e0b','#ef4444','#ec4899','#14b8a6','#f97316','#a78bfa','#60a5fa'];
let _charts = {};
let _analyticsData = null;
let _analyticsPeriod = '30d';
let _customFrom = '', _customTo = '';
let _sortCol = 'totalTokens', _sortDir = -1;
let _chartJsLoaded = false, _chartJsPromise = null;

function ensureChartJs() {
  if (_chartJsLoaded) return Promise.resolve();
  if (_chartJsPromise) return _chartJsPromise;
  _chartJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
    s.onload = () => {
      _chartJsLoaded = true;
      Chart.defaults.color = '#71717a';
      Chart.defaults.borderColor = '#2a2a32';
      Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      resolve();
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _chartJsPromise;
}

function _destroyChart(k) { if (_charts[k]) { _charts[k].destroy(); delete _charts[k]; } }

function fmtUsd(v) {
  if (!v || v === 0) return '$0.00';
  if (v < 0.01) return '$<0.01';
  return '$' + v.toFixed(2);
}

function fmtDateLbl(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function _darkOpts(extra) {
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
    plugins: {
      legend: { position: 'bottom', labels: { color:'#71717a', boxWidth:10, padding:10, font:{size:11} } },
      tooltip: { backgroundColor:'#18181b', borderColor:'#3a3a44', borderWidth:1, titleColor:'#f4f4f5', bodyColor:'#a1a1aa', padding:10, cornerRadius:6, callbacks: {} },
    },
    scales: {
      x: { ticks:{ color:'#71717a', maxTicksLimit:8, font:{size:11} }, grid:{ color:'#1c1c24' } },
      y: { ticks:{ color:'#71717a', font:{size:11} }, grid:{ color:'#1c1c24' }, beginAtZero:true },
    },
  };
  return Object.assign(base, extra || {});
}

function applyCustomRange() {
  const from = document.getElementById('ap-from')?.value;
  const to   = document.getElementById('ap-to')?.value;
  if (!from && !to) return;
  if (from && to && from > to) { toast('From date must be before To date', true); return; }
  _customFrom = from || '';
  _customTo   = to   || '';
  // Deactivate all period pills when custom range is active
  ['today','7d','30d','90d'].forEach(p => document.getElementById('ap-'+p)?.classList.remove('active-period'));
  loadAnalytics(null);
}

async function loadAnalytics(period) {
  if (window._demoMode) { _renderDemoAnalytics(); return; }
  const usingCustom = _customFrom || _customTo;
  if (!usingCustom) {
    period = period || _analyticsPeriod;
    _analyticsPeriod = period;
    _customFrom = ''; _customTo = '';
    // Clear date inputs when switching back to a preset
    const fromEl = document.getElementById('ap-from');
    const toEl   = document.getElementById('ap-to');
    if (fromEl) fromEl.value = '';
    if (toEl)   toEl.value   = '';
    ['today','7d','30d','90d'].forEach(p => {
      document.getElementById('ap-'+p)?.classList.toggle('active-period', p === period);
    });
  }
  const el = document.getElementById('analytics-body');
  el.innerHTML = '<div style="text-align:center;padding:3rem"><div class="loader"></div></div>';
  try {
    await ensureChartJs();
    const qs = usingCustom
      ? `from=${_customFrom}&to=${_customTo || new Date().toISOString().slice(0,10)}`
      : `period=${period}`;
    const [summary, teamsTs, modelsTs, tkData] = await Promise.all([
      GET(`/admin/usage?${qs}`),
      GET(`/admin/analytics/timeseries/teams?${qs}`),
      GET(`/admin/analytics/timeseries/models?${qs}`),
      GET(`/admin/usage/by-team-key?${qs}`),
    ]);
    _analyticsData = { summary, teamTs: teamsTs.series || [], modelTs: modelsTs.series || [], leaderboard: tkData.leaderboard || [] };
    _renderAnalyticsBody(_analyticsData);
  } catch(e) { el.innerHTML = `<div style="color:var(--red);padding:2rem">${e.message}</div>`; }
}

function _renderAnalyticsBody(d) {
  const t = d.summary.totals;
  const inPct  = t.totalTokens > 0 ? Math.round(t.inputTokens  / t.totalTokens * 100) : 0;
  const outPct = t.totalTokens > 0 ? Math.round(t.outputTokens / t.totalTokens * 100) : 0;
  document.getElementById('analytics-body').innerHTML = `
    <div class="a-heroes">
      <div class="stat"><div class="stat-label">Requests</div><div class="stat-value">${fmtNum(t.requests)}</div><div class="stat-sub">this period</div></div>
      <div class="stat"><div class="stat-label">Total tokens</div><div class="stat-value">${fmtNum(t.totalTokens)}</div><div class="stat-sub">input + output</div></div>
      <div class="stat"><div class="stat-label">Input tokens</div><div class="stat-value">${fmtNum(t.inputTokens)}</div><div class="stat-sub">${inPct}% of total</div></div>
      <div class="stat"><div class="stat-label">Output tokens</div><div class="stat-value">${fmtNum(t.outputTokens)}</div><div class="stat-sub">${outPct}% of total</div></div>
      <div class="stat"><div class="stat-label">Est. cost</div><div class="stat-value" style="color:var(--green)">${fmtUsd(t.estimatedUsd)}</div><div class="stat-sub">model pricing</div></div>
    </div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="card"><div class="card-title">Requests over time</div><div class="chart-box"><canvas id="chart-req"></canvas></div></div>
      <div class="card"><div class="card-title">Token usage by model</div><div class="chart-box"><canvas id="chart-tok"></canvas></div></div>
    </div>
    <div class="grid-2" style="margin-bottom:12px">
      <div class="card"><div class="card-title">Cost trend (USD)</div><div class="chart-box"><canvas id="chart-cost"></canvas></div></div>
      <div class="card"><div class="card-title">Input vs Output by model</div><div class="chart-box"><canvas id="chart-io"></canvas></div></div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin-bottom:0">By team</div>
        <button class="btn-secondary btn-sm" onclick="exportAnalyticsCSV()">↓ CSV</button>
      </div>
      <div id="team-analytics-table">${_renderTeamTable(d.leaderboard)}</div>
    </div>`;
  requestAnimationFrame(() => {
    _buildReqChart(d.teamTs, d.summary.byDay);
    _buildTokChart(d.modelTs);
    _buildCostChart(d.summary.byDay);
    _buildIOChart(d.summary.byModel);
  });
}

// Chart 1 — Requests over time (line, multi-color per team)
function _buildReqChart(teamTs, byDay) {
  _destroyChart('req');
  const canvas = document.getElementById('chart-req');
  if (!canvas) return;
  const dates  = [...new Set(byDay.map(d => d.date))].sort();
  const teams  = [...new Set(teamTs.map(r => r.teamName))];
  let datasets;
  if (teams.length) {
    // One pass to index by date+team, so the nested map below is O(1) per cell
    // rather than a linear scan of teamTs.
    const reqLookup = new Map();
    teamTs.forEach(r => { const k = r.date+'|'+r.teamName; if (!reqLookup.has(k)) reqLookup.set(k, r.requests || 0); });
    datasets = teams.map((team, i) => {
      const c = CHART_PALETTE[i % CHART_PALETTE.length];
      return { label: team, data: dates.map(date => reqLookup.get(date+'|'+team) || 0),
        borderColor: c, backgroundColor: c+'18', borderWidth:2, pointRadius:3, pointHoverRadius:5, tension:0.35, fill:false };
    });
  } else {
    const reqMap = new Map(byDay.map(d => [d.date, d.requests || 0]));
    datasets = [{ label:'Total requests', data: dates.map(d => reqMap.get(d) || 0),
      borderColor: CHART_PALETTE[0], backgroundColor: CHART_PALETTE[0]+'18', borderWidth:2, pointRadius:3, tension:0.35, fill:false }];
  }
  _charts['req'] = new Chart(canvas, { type:'line', data:{ labels: dates.map(fmtDateLbl), datasets }, options: _darkOpts() });
}

// Chart 2 — Tokens by model (stacked bar)
function _buildTokChart(modelTs) {
  _destroyChart('tok');
  const canvas = document.getElementById('chart-tok');
  if (!canvas) return;
  if (!modelTs || !modelTs.length) { canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px">No data yet</div>'; return; }
  const dates  = [...new Set(modelTs.map(r => r.date))].sort();
  const models = [...new Set(modelTs.map(r => r.model))];
  const tokLookup = new Map();
  modelTs.forEach(r => { const k = r.date+'|'+r.model; if (!tokLookup.has(k)) tokLookup.set(k, r.tokens || 0); });
  const datasets = models.map((model, i) => {
    const c = CHART_PALETTE[i % CHART_PALETTE.length];
    return { label: model, data: dates.map(date => tokLookup.get(date+'|'+model) || 0),
      backgroundColor: c + 'cc', borderColor: c, borderWidth:1 };
  });
  _charts['tok'] = new Chart(canvas, { type:'bar', data:{ labels: dates.map(fmtDateLbl), datasets },
    options: _darkOpts({ scales: { x:{ stacked:true, ticks:{color:'#71717a',maxTicksLimit:8,font:{size:11}}, grid:{color:'#1c1c24'} }, y:{ stacked:true, ticks:{color:'#71717a',font:{size:11},callback:v=>fmtNum(v)}, grid:{color:'#1c1c24'}, beginAtZero:true } } }) });
}

// Chart 3 — Cost trend (area)
function _buildCostChart(byDay) {
  _destroyChart('cost');
  const canvas = document.getElementById('chart-cost');
  if (!canvas) return;
  const usdData = byDay.map(d => +(d.usd || 0).toFixed(5));
  if (!usdData.some(v => v > 0)) {
    canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:12px;text-align:center;padding:1rem">Set model pricing in the Models tab<br>to see cost estimates here.</div>';
    return;
  }
  _charts['cost'] = new Chart(canvas, { type:'line',
    data: { labels: byDay.map(d => fmtDateLbl(d.date)), datasets: [{ label:'Est. cost (USD)', data: usdData,
      borderColor:'#22c55e', backgroundColor:'rgba(34,197,94,0.07)', borderWidth:2, fill:true, pointRadius:2, tension:0.3 }] },
    options: _darkOpts({ plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{color:'#71717a',maxTicksLimit:8,font:{size:11}}, grid:{color:'#1c1c24'} }, y:{ ticks:{color:'#71717a',font:{size:11},callback:v=>'$'+v.toFixed(3)}, grid:{color:'#1c1c24'}, beginAtZero:true } } }) });
}

// Chart 4 — Input vs Output by model (horizontal grouped bar)
function _buildIOChart(byModel) {
  _destroyChart('io');
  const canvas = document.getElementById('chart-io');
  if (!canvas) return;
  const entries = Object.entries(byModel).sort((a,b) => b[1].tokens - a[1].tokens).slice(0, 8);
  if (!entries.length) { canvas.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px">No data yet</div>'; return; }
  const labels = entries.map(([m]) => m.length > 26 ? m.slice(0,24)+'…' : m);
  _charts['io'] = new Chart(canvas, { type:'bar',
    data: { labels, datasets: [
      { label:'Input',  data: entries.map(([,v]) => v.inputTokens),  backgroundColor:'rgba(59,130,246,0.75)',  borderColor:'#3b82f6', borderWidth:1 },
      { label:'Output', data: entries.map(([,v]) => v.outputTokens), backgroundColor:'rgba(139,92,246,0.75)', borderColor:'#8b5cf6', borderWidth:1 },
    ]},
    options: { indexAxis:'y', responsive:true, maintainAspectRatio:false, animation:{duration:350},
      plugins:{ legend:{ position:'bottom', labels:{color:'#71717a',boxWidth:10,padding:10,font:{size:11}} }, tooltip:{backgroundColor:'#18181b',borderColor:'#3a3a44',borderWidth:1,titleColor:'#f4f4f5',bodyColor:'#a1a1aa',padding:10,cornerRadius:6} },
      scales:{ x:{ ticks:{color:'#71717a',font:{size:11},callback:v=>fmtNum(v)}, grid:{color:'#1c1c24'}, beginAtZero:true }, y:{ ticks:{color:'#71717a',font:{size:11}}, grid:{color:'#1c1c24'} } } } });
}

// Team table (client-side sortable)
function _renderTeamTable(leaderboard) {
  if (!leaderboard || !leaderboard.length) return '<div style="color:var(--muted);font-size:13px;padding:8px 0">No team key usage in this period.</div>';
  const sorted = [...leaderboard].sort((a,b) => _sortDir * ((a[_sortCol]||0) > (b[_sortCol]||0) ? 1 : -1));
  const th = (col, label) => `<th class="a-sort-btn" onclick="sortTeamTable('${col}')" style="cursor:pointer">${label}${_sortCol===col?(_sortDir>0?' ↑':' ↓'):''}</th>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Team</th>${th('totalTokens','Tokens')}${th('requests','Requests')}${th('estimatedUsd','Est. cost')}<th title="Estimated lines of code (tokens ÷ 50)">Est. LoC ⓘ</th><th>Input / Output</th></tr></thead>
    <tbody>${sorted.map((e,i) => `<tr>
      <td>${i===0?'🥇 ':i===1?'🥈 ':i===2?'🥉 ':''}<strong>${e.name}</strong></td>
      <td>${fmtNum(e.totalTokens)}</td>
      <td>${e.requests}</td>
      <td>${fmtUsd(e.estimatedUsd||0)}</td>
      <td>~${fmtNum(Math.round(e.totalTokens/50))}</td>
      <td><span style="color:var(--blue)">${fmtNum(e.inputTokens)}</span> <span style="color:var(--muted)">/</span> <span style="color:var(--accent)">${fmtNum(e.outputTokens)}</span></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function sortTeamTable(col) {
  if (_sortCol === col) _sortDir *= -1; else { _sortCol = col; _sortDir = -1; }
  if (_analyticsData) document.getElementById('team-analytics-table').innerHTML = _renderTeamTable(_analyticsData.leaderboard);
}

function exportAnalyticsCSV() {
  if (!_analyticsData) { toast('No data to export', true); return; }
  const rows = [['Team','Requests','Input Tokens','Output Tokens','Total Tokens','Est. Cost USD','Est. LoC']];
  (_analyticsData.leaderboard || []).forEach(e => rows.push([e.name, e.requests, e.inputTokens, e.outputTokens, e.totalTokens, (e.estimatedUsd||0).toFixed(4), Math.round(e.totalTokens/50)]));
  const csv = rows.map(r => r.join(',')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv],{type:'text/csv'})), download: `nexus-analytics-${_analyticsPeriod}-${new Date().toISOString().slice(0,10)}.csv` });
  a.click();
}

// Demo analytics
function _renderDemoAnalytics() {
  ensureChartJs().then(() => {
    const demoDays = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i*86400000);
      const iso = d.toISOString().slice(0,10);
      const tok = Math.round(60000 + Math.random()*80000);
      const req = Math.round(3 + Math.random()*6);
      demoDays.push({ date:iso, tokens:tok, requests:req, usd:+(tok*0.0000035).toFixed(5) });
    }
    const demoTeamTs = demoDays.flatMap(d => [
      { date:d.date, teamName:'Abbas',          requests: Math.round(d.requests*0.6), tokens: Math.round(d.tokens*0.6) },
      { date:d.date, teamName:'Frontend Team',  requests: Math.round(d.requests*0.4), tokens: Math.round(d.tokens*0.4) },
    ]);
    const demoModelTs = demoDays.flatMap(d => [
      { date:d.date, model:'claude-3-5-sonnet-20241022', tokens: Math.round(d.tokens*0.65) },
      { date:d.date, model:'gemini-2.0-flash',           tokens: Math.round(d.tokens*0.35) },
    ]);
    const totTok = demoDays.reduce((s,d)=>s+d.tokens,0);
    const totReq = demoDays.reduce((s,d)=>s+d.requests,0);
    const totUsd = demoDays.reduce((s,d)=>s+d.usd,0);
    _analyticsData = {
      summary: { totals:{ requests:totReq, totalTokens:totTok, inputTokens:Math.round(totTok*0.75), outputTokens:Math.round(totTok*0.25), estimatedUsd:totUsd }, byModel:{
        'claude-3-5-sonnet-20241022':{ inputTokens:Math.round(totTok*0.49), outputTokens:Math.round(totTok*0.16), tokens:Math.round(totTok*0.65), usd:totUsd*0.85, requests:Math.round(totReq*0.65) },
        'gemini-2.0-flash':          { inputTokens:Math.round(totTok*0.26), outputTokens:Math.round(totTok*0.09), tokens:Math.round(totTok*0.35), usd:totUsd*0.15, requests:Math.round(totReq*0.35) },
      }, byDay: demoDays },
      teamTs: demoTeamTs,
      modelTs: demoModelTs,
      leaderboard:[
        { id:'1', name:'Abbas',         inputTokens:Math.round(totTok*0.45), outputTokens:Math.round(totTok*0.15), totalTokens:Math.round(totTok*0.6), requests:Math.round(totReq*0.6), estimatedUsd:totUsd*0.6 },
        { id:'2', name:'Frontend Team', inputTokens:Math.round(totTok*0.30), outputTokens:Math.round(totTok*0.10), totalTokens:Math.round(totTok*0.4), requests:Math.round(totReq*0.4), estimatedUsd:totUsd*0.4 },
      ],
    };
    _renderAnalyticsBody(_analyticsData);
  }).catch(() => { document.getElementById('analytics-body').innerHTML = '<div style="color:var(--muted);text-align:center;padding:3rem">Chart.js failed to load (offline?)</div>'; });
}


export {
  loadAnalytics, applyCustomRange, sortTeamTable, exportAnalyticsCSV, fmtUsd, fmtDateLbl,
};
