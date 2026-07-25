import { useEffect, useRef } from 'preact/hooks';
import { Server, Database, Zap, Activity, HardDrive } from 'lucide-preact';
import { Card, Spinner, Button } from '../../ui';
import { useApi } from '../../hooks/useApi';
import type { HealthOverview, HealthStatus, ReadyCheck } from '../../api';
import { StatusPill, Sparkline, RadialGauge, StatusStrip, fmtMs, fmtBytes, fmtUptime, fmtCount } from './viz';
import p from '../pages.module.css';
import s from './health.module.css';

// The Server tab (P7.12): the gateway's own vitals — the process, Redis, Postgres — fed by the
// 15-second sampler. Everything on screen is measured; where a ceiling does not exist (Redis with
// no maxmemory, no cgroup limit) the page says so in prose instead of drawing a gauge against an
// invented maximum.

const POLL_MS = 15_000;

export function ServerTab() {
  const { data, loading, error, reload } = useApi<HealthOverview>('/admin/health/overview');

  // Follow the sampler's own cadence. Through a ref: `reload` is a fresh closure per render, and
  // depending on it would tear the interval down every render.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const t = setInterval(() => reloadRef.current(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  if (loading && !data) return <div class={p.centered}><Spinner /> <span>Probing the gateway…</span></div>;
  if (error || !data) {
    return (
      <div class={p.errBody}>
        <p>Couldn’t read gateway health{error ? ` — ${error}` : ''}.</p>
        <Button size="sm" onClick={reload}>Retry</Button>
      </div>
    );
  }

  const d = data;
  const check = (id: ReadyCheck['id']): ReadyCheck | undefined => d.checks.find((c) => c.id === id);
  const redisStatus = check('redis')?.status ?? 'down';
  const pgStatus    = check('postgres')?.status ?? 'down';
  const procStatus  = ((check('eventLoop')?.status === 'healthy' && check('heap')?.status === 'healthy')
    ? 'healthy' : 'degraded') as HealthStatus;

  const sampledAgo = d.sampledAt ? Math.max(0, Math.round((Date.now() - new Date(d.sampledAt).getTime()) / 1000)) : null;
  const collecting = d.window.samples < d.window.capacity;

  // The KV card's identity comes from the server, so a gateway holding counters in process is never
  // labelled as a Redis it does not have. Redis-only figures (version, uptime, clients, ops/s) are
  // simply absent from that store's INFO and already render as "—" rather than invented zeros.
  const isRedis = (d.backend?.kv ?? 'redis') === 'redis';
  const kvName  = d.backend?.kvLabel ?? 'Redis';

  const borderFor = (st: HealthStatus) => (st === 'down' ? s.critBorder : st === 'degraded' ? s.warnBorder : '');
  const bigTone   = (st: HealthStatus) => (st === 'down' ? s.critText : st === 'degraded' ? s.warnText : '');

  return (
    <>
      {/* ── Global status banner ── */}
      <div class={s.banner}>
        <div class={s.bannerLeft}>
          <span class={`${s.bannerState} ${s['st_' + d.status]}`}><span class={s.pulse} />{d.summary.split(' · ')[0]}</span>
          {/* The fallback names the stores the server reports, not the two this gateway used to be
              hardcoded to. On a standalone gateway "Redis, PostgreSQL and the process itself" was
              simply a description of something else. */}
          <span class={s.bannerSub}>
            {d.summary.includes(' · ')
              ? d.summary.split(' · ')[1]
              : `${d.backend?.kvLabel ?? 'Redis'}, ${d.backend?.dbLabel ?? 'PostgreSQL'} and the process itself`}
          </span>
        </div>
        <div class={s.bannerMid}>
          <div class={s.stripLab}>
            <span>Last {d.window.minutes} minutes</span>
            <span class={s.live}>● live · probes every 15s</span>
          </div>
          <StatusStrip cells={d.strip} />
        </div>
        <div class={s.bannerRight}>
          <span class={s.probe}>
            <span class={s.probeUrl}>GET /ready</span>
            <span class={`${s.probeVal} ${s['st_' + (d.ready ? 'healthy' : 'down')]}`}>
              {d.ready ? '200 · ready' : `503 · ${d.checks.find((c) => c.status === 'down')?.label ?? 'not ready'}`}
            </span>
          </span>
          <span class={s.probe}>
            <span class={s.probeUrl}>GET /health</span>
            <span class={`${s.probeVal} ${s.st_healthy}`}>200 · alive</span>
          </span>
        </div>
      </div>

      {collecting && (
        <p class={s.collecting}>
          History resets with the process: {d.window.samples} of {d.window.capacity} samples collected —
          the full {d.window.minutes}-minute picture builds up as the gateway runs.
        </p>
      )}

      {/* ── Storage backend (S0) ──
          Guarded on `backend` rather than assumed: a gateway older than the field, or the demo's
          frozen snapshot, simply omits it and the card does not render. Reading through a missing
          object here would take the whole tab down with it. */}
      {d.backend && (
        <div class={`${s.dep} ${p.section} ${d.backend.durable ? '' : s.warnBorder}`}>
          <div class={s.depHead}>
            <span class={s.depIco}><HardDrive size={13} /></span>
            <span class={s.depName}>Storage</span>
            {/* "Server mode", not "Server": this tab is itself called Server, and a bare chip reading
                the same word next to it is a puzzle rather than a label. */}
            <span class={s.chip}>{d.backend.mode === 'server' ? 'Server mode' : 'Standalone mode'}</span>
          </div>
          <div class={s.chips}>
            <span class={s.chip}>Database <b>{d.backend.dbLabel}</b></span>
            <span class={s.chip}>Counters &amp; sessions <b>{d.backend.kvLabel}</b></span>
            <span class={s.chip}>{d.backend.durable ? 'Survives a restart' : 'Resets on restart'}</span>
          </div>
          {d.backend.warning && <p class={s.storageWarn}>{d.backend.warning}</p>}
        </div>
      )}

      {/* ── Dependency cards ── */}
      <div class={`${s.depGrid} ${p.section}`}>
        <div class={`${s.dep} ${borderFor(procStatus)}`}>
          <div class={s.depHead}>
            <span class={s.depIco}><Server size={13} /></span>
            <span class={s.depName}>Gateway process</span>
            <StatusPill status={procStatus} />
          </div>
          <div class={s.depMain}>
            <div>
              <span class={`${s.depBig} ${bigTone(procStatus)}`}>{fmtMs(d.process.loopP50Ms)}</span>
              <span class={s.depLbl}>event-loop lag p50</span>
            </div>
            <Sparkline points={d.series.map((x) => x.loopP99Ms)} label="Event-loop lag p99 per minute, last hour" />
          </div>
          <div class={s.chips}>
            <span class={s.chip}>p99 <b>{fmtMs(d.process.loopP99Ms)}</b></span>
            <span class={s.chip}>max 1h <b>{fmtMs(d.process.loopMaxP99Ms)}</b></span>
            <span class={s.chip}>CPU <b>{d.process.cpuPct.toFixed(1)}%</b></span>
          </div>
          <div class={s.depFoot}><span>Node {d.process.node.replace(/^v/, '')}</span><span>up {fmtUptime(d.process.uptimeSeconds)}</span><span>pid {d.process.pid}</span></div>
        </div>

        <div class={`${s.dep} ${borderFor(redisStatus)}`}>
          <div class={s.depHead}>
            <span class={s.depIco}><Zap size={13} /></span>
            {/* Named from the backend the gateway reports, not hardcoded: with counters held in
                process there is no Redis, and a card confidently titled "Redis · Healthy" would be
                reporting on something that does not exist. Falls back to "Redis" for a gateway too
                old to send `backend`. */}
            <span class={s.depName}>{kvName}</span>
            <StatusPill status={redisStatus} />
          </div>
          <div class={s.depMain}>
            <div>
              <span class={`${s.depBig} ${bigTone(redisStatus)}`}>{fmtMs(d.redis.pingMs)}</span>
              <span class={s.depLbl}>{isRedis ? 'PING round-trip' : 'read round-trip'}</span>
            </div>
            <Sparkline points={d.series.map((x) => x.redisMs)} tone={redisStatus === 'healthy' ? 'ok' : 'warn'} label={`${kvName} latency per minute, last hour`} />
          </div>
          <div class={s.chips}>
            <span class={s.chip}>p95 <b>{fmtMs(d.redis.p95Ms)}</b></span>
            <span class={s.chip}>p99 <b>{fmtMs(d.redis.p99Ms)}</b></span>
            <span class={s.chip}><b>{fmtCount(d.redis.info?.opsPerSec ?? null)}</b> ops/s</span>
          </div>
          <div class={s.depFoot}>
            <span>{d.redis.info?.version ? `v${d.redis.info.version}` : 'version —'}</span>
            <span>up {fmtUptime(d.redis.info?.uptimeSeconds ?? null)}</span>
            <span>{d.redis.info?.connectedClients ?? '—'} clients</span>
          </div>
        </div>

        <div class={`${s.dep} ${borderFor(pgStatus)}`}>
          <div class={s.depHead}>
            <span class={s.depIco}><Database size={13} /></span>
            <span class={s.depName}>{d.backend?.dbLabel ?? 'PostgreSQL'}</span>
            <StatusPill status={pgStatus} />
          </div>
          <div class={s.depMain}>
            <div>
              <span class={`${s.depBig} ${bigTone(pgStatus)}`}>{fmtMs(d.postgres.queryMs)}</span>
              <span class={s.depLbl}>query round-trip</span>
            </div>
            <Sparkline points={d.series.map((x) => x.pgMs)} tone={pgStatus === 'healthy' ? 'ok' : 'warn'} label="Postgres query latency per minute, last hour" />
          </div>
          <div class={s.chips}>
            <span class={`${s.chip} ${pgStatus !== 'healthy' ? s.warnChip : ''}`}>p95 <b>{fmtMs(d.postgres.p95Ms)}</b></span>
            <span class={`${s.chip} ${pgStatus !== 'healthy' ? s.warnChip : ''}`}>p99 <b>{fmtMs(d.postgres.p99Ms)}</b></span>
            <span class={s.chip}>threshold <b>{check('postgres')?.threshold ?? '—'}</b></span>
          </div>
          <div class={s.depFoot}>
            <span>{d.postgres.stats?.version ? `v${d.postgres.stats.version}` : 'version —'}</span>
            {/* A file has no connection pool, so "conns —" on SQLite reads as a failed measurement of
                something that does not exist. The journal mode is the equivalent fact worth the slot. */}
            <span>
              {d.backend?.db === 'sqlite'
                ? (d.postgres.stats?.journalMode ? `${d.postgres.stats.journalMode.toLowerCase()} journal` : 'journal —')
                : d.postgres.stats?.connections && d.postgres.stats.maxConnections
                  ? `${d.postgres.stats.connections.total} / ${d.postgres.stats.maxConnections} conns`
                  : 'conns —'}
            </span>
            <span>{fmtBytes(d.postgres.stats?.databaseBytes ?? null)}</span>
          </div>
        </div>
      </div>

      {/* ── Deep panels ── */}
      <div class={`${p.grid} ${p.cols2} ${p.section}`}>
        <RedisPanel d={d} sampledAgo={sampledAgo} />
        <DatabasePanel d={d} sampledAgo={sampledAgo} />
      </div>

      <div class={p.section}><ProcessPanel d={d} sampledAgo={sampledAgo} /></div>

      {/* ── Readiness checks ── */}
      <Card class={p.section}>
        <div class={s.panelHead}>
          <span class={s.depIco}><Activity size={13} /></span>
          <b>Readiness checks</b>
          <span class={s.panelTag}>what /ready verifies</span>
          <span class={s.panelMeta}>your load balancer sees exactly this</span>
        </div>
        <div class={`${s.check} ${s.checkHead}`}><span>Check</span><span>Measured</span><span>Threshold</span><span>Status</span></div>
        {d.checks.map((c) => (
          <div key={c.id} class={s.check}>
            <span>{c.label}</span>
            <span class={s.mono}>{c.measured}</span>
            <span class={s.mono}>{c.threshold}</span>
            <StatusPill status={c.status}>{c.status === 'healthy' ? 'Pass' : c.status === 'degraded' ? 'Slow' : 'Fail'}</StatusPill>
          </div>
        ))}
      </Card>
    </>
  );
}

function SampledMeta({ sampledAgo }: { sampledAgo: number | null }) {
  return <span class={s.panelMeta}>{sampledAgo === null ? 'no sample yet' : `sampled ${sampledAgo}s ago`}</span>;
}

function RedisPanel({ d, sampledAgo }: { d: HealthOverview; sampledAgo: number | null }) {
  // S1's in-process store implements INFO, so this panel genuinely renders in standalone mode —
  // which is why every label in it has to be named from the server rather than assumed.
  const kvName = d.backend?.kvLabel ?? 'Redis';
  const info = d.redis.info;
  const frag = info?.fragmentationRatio ?? null;
  return (
    <Card>
      <div class={s.panelHead}>
        {/* Named from the server, like the dependency card above it. S1 fixed the card and left this
            panel behind, so a standalone gateway showed "In-process memory · Healthy" in the card and
            a panel titled "Redis" directly underneath. */}
        <span class={s.depIco}><Zap size={13} /></span><b>{d.backend?.kvLabel ?? 'Redis'}</b>
        <span class={s.panelTag}>in-memory store</span>
        <SampledMeta sampledAgo={sampledAgo} />
      </div>

      {info ? (
        <>
          <div class={s.gaugeRow}>
            {info.maxMemoryBytes !== null && info.usedMemoryBytes !== null ? (
              <div class={s.gaugeBox}>
                <RadialGauge
                  pct={(info.usedMemoryBytes / info.maxMemoryBytes) * 100}
                  value={`${Math.round((info.usedMemoryBytes / info.maxMemoryBytes) * 100)}%`}
                  sub="memory"
                  label={`${kvName} memory ${fmtBytes(info.usedMemoryBytes)} of ${fmtBytes(info.maxMemoryBytes)}`}
                />
                <div class={s.gaugeCap}>
                  {fmtBytes(info.usedMemoryBytes)} / {fmtBytes(info.maxMemoryBytes)}<br />
                  <span class={s.gaugeFree}>{fmtBytes(info.maxMemoryBytes - info.usedMemoryBytes)} headroom</span>
                </div>
              </div>
            ) : (
              <div class={s.noLimit}>
                <span class={s.noLimitVal}>{fmtBytes(info.usedMemoryBytes)}</span>
                <span>memory used — <code>maxmemory</code> is not set, so there is no ceiling to measure against and no percentage to show</span>
              </div>
            )}

            {d.redis.hitRate !== null ? (
              <div class={s.gaugeBox}>
                <RadialGauge
                  pct={d.redis.hitRate * 100}
                  value={`${(d.redis.hitRate * 100).toFixed(1)}%`}
                  sub="hit rate"
                  warnAt={101 /* a high hit rate is good — never tint it amber */}
                  label={`${kvName} keyspace hit rate ${(d.redis.hitRate * 100).toFixed(1)} percent`}
                />
                <div class={s.gaugeCap}>
                  {fmtCount(info.keyspaceHits)} hits / {fmtCount(info.keyspaceMisses)} misses<br />
                  <span class={s.gaugeFree}>since {kvName.toLowerCase() === "redis" ? "Redis" : "the process"} restarted</span>
                </div>
              </div>
            ) : (
              <div class={s.noLimit}>
                <span class={s.noLimitVal}>—</span>
                <span>no keyspace reads yet, so there is no hit rate to report</span>
              </div>
            )}
          </div>

          <div class={s.kpiGrid}>
            <span class={s.kpi}><span class={s.kpiLbl}>Ops / sec</span><span class={s.kpiVal}>{fmtCount(info.opsPerSec)}</span></span>
            <span class={s.kpi}><span class={s.kpiLbl}>Clients</span><span class={s.kpiVal}>{info.connectedClients ?? '—'}</span></span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Evicted keys</span><span class={s.kpiVal}>{fmtCount(info.evictedKeys)}</span>
              <span class={`${s.kpiNote} ${(info.evictedKeys ?? 0) > 0 ? s.wn : s.ok}`}>
                {(info.evictedKeys ?? 0) > 0 ? 'memory pressure — keys being dropped' : 'none — no pressure'}
              </span>
            </span>
            <span class={s.kpi}><span class={s.kpiLbl}>Expired keys</span><span class={s.kpiVal}>{fmtCount(info.expiredKeys)}</span><span class={s.kpiNote}>normal TTL churn</span></span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Fragmentation</span><span class={s.kpiVal}>{frag === null ? '—' : frag.toFixed(2)}</span>
              {frag !== null && <span class={`${s.kpiNote} ${frag > 1.5 ? s.wn : s.ok}`}>{frag > 1.5 ? 'high — RAM exceeds data' : 'healthy < 1.5'}</span>}
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Blocked clients</span><span class={s.kpiVal}>{info.blockedClients ?? '—'}</span>
              {info.blockedClients !== null && <span class={`${s.kpiNote} ${info.blockedClients > 0 ? s.wn : s.ok}`}>{info.blockedClients > 0 ? 'commands waiting' : 'no stalls'}</span>}
            </span>
          </div>
        </>
      ) : (
        <p class={p.setDesc}>
          This {kvName} does not expose <code>INFO</code> (managed instances sometimes restrict it), so the
          detail here is unavailable — the PING probe above still verifies it is alive and fast.
        </p>
      )}
    </Card>
  );
}

/**
 * The durable store's panel.
 *
 * Titled and shaped from the engine the server reports, never hardcoded. The two engines expose
 * genuinely different facts — a client/server database has connections and a shared buffer cache,
 * a single file has a journal mode and free pages — so this branches rather than rendering one
 * layout with half its readings blank. A wall of "—" reads as "your database is unreachable",
 * which for a perfectly healthy SQLite file would be both alarming and wrong.
 */
function DatabasePanel({ d, sampledAgo }: { d: HealthOverview; sampledAgo: number | null }) {
  const st       = d.postgres.stats;
  const isSqlite = d.backend?.db === 'sqlite';
  const dbName   = d.backend?.dbLabel ?? 'PostgreSQL';
  const maxTable = st?.largestTables.length ? Math.max(...st.largestTables.map((t) => t.bytes), 1) : 1;
  const rollbackNote = (() => {
    if (st?.rollbacks === null || st?.commits === null || !st) return null;
    const total = (st.commits ?? 0) + (st.rollbacks ?? 0);
    return total > 0 ? `${(((st.rollbacks ?? 0) / total) * 100).toFixed(1)}% of txns` : null;
  })();

  // Shared by both engines: dbstat and pg_stat_user_tables answer the same question.
  const largestTables = st && st.largestTables.length > 0 ? (
    <div class={s.tblRows}>
      <div class={`${s.tblRow} ${s.tblHead}`}><span>Largest tables</span><span>rows</span><span>size</span></div>
      {st.largestTables.map((t) => (
        <div key={t.name} class={s.tblRow}>
          <span class={s.tblName}>{t.name}</span>
          <span>{fmtCount(t.rows)}</span>
          <span class={s.tblBar}><i style={{ width: `${Math.max(2, Math.round((t.bytes / maxTable) * 100))}%` }} />{fmtBytes(t.bytes)}</span>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <Card>
      <div class={s.panelHead}>
        <span class={s.depIco}><Database size={13} /></span><b>{dbName}</b>
        <span class={s.panelTag}>durable store</span>
        <SampledMeta sampledAgo={sampledAgo} />
      </div>

      {!st ? (
        <p class={p.setDesc}>
          {dbName} introspection is unavailable on this instance — the query probe above still verifies
          it answers. No “disk free” is shown anywhere here on purpose: neither engine can report free
          disk from SQL, so a fullness bar would be invented.
        </p>
      ) : isSqlite ? (
        <>
          <div class={s.kpiGrid}>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Database file</span>
              <span class={s.kpiVal}>{fmtBytes(st.databaseBytes)}</span>
              <span class={s.kpiNote}>on disk</span>
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Journal mode</span>
              <span class={s.kpiVal}>{st.journalMode ? st.journalMode.toUpperCase() : '—'}</span>
              {/* The one setting an operator of a file-backed gateway can act on: under WAL a read
                  proceeds during a write, under DELETE it waits. Judged, not merely displayed. */}
              {st.journalMode && (
                <span class={`${s.kpiNote} ${st.journalMode.toLowerCase() === 'wal' ? s.ok : s.wn}`}>
                  {st.journalMode.toLowerCase() === 'wal' ? 'reads run during writes' : 'reads wait for writes'}
                </span>
              )}
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Reclaimable</span>
              <span class={s.kpiVal}>{fmtBytes(st.reclaimableBytes)}</span>
              {st.reclaimableBytes !== null && (
                <span class={s.kpiNote}>{st.reclaimableBytes > 0 ? 'freed by VACUUM' : 'nothing to reclaim'}</span>
              )}
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Page size</span>
              <span class={s.kpiVal}>{fmtBytes(st.pageSize)}</span>
            </span>
          </div>

          {largestTables}

          {/* Says WHY the client/server numbers are absent. Without this the panel reads as a
              Postgres card with its readings missing, rather than a complete SQLite one. */}
          <p class={p.setDesc}>
            Connection counts, buffer-cache hit ratio and cumulative transaction totals are not shown
            because {dbName} has none — it is a file opened by this process, not a server with a
            connection pool and a shared cache. The row counts above are exact rather than estimated.
          </p>
        </>
      ) : (
        <>
          <div class={s.gaugeRow}>
            {st.connections && st.maxConnections ? (
              <div class={s.gaugeBox}>
                <RadialGauge
                  pct={(st.connections.total / st.maxConnections) * 100}
                  value={String(st.connections.total)}
                  sub={`/ ${st.maxConnections} conns`}
                  label={`Postgres connections ${st.connections.total} of ${st.maxConnections}`}
                />
                <div class={s.gaugeCap}>
                  {st.connections.active} active · {st.connections.idle} idle<br />
                  <span class={s.gaugeFree}>{st.maxConnections - st.connections.total} free</span>
                </div>
              </div>
            ) : (
              <div class={s.noLimit}><span class={s.noLimitVal}>—</span><span>connection detail unavailable on this instance</span></div>
            )}

            {st.cacheHitRatio !== null ? (
              <div class={s.gaugeBox}>
                <RadialGauge
                  pct={st.cacheHitRatio * 100}
                  value={`${(st.cacheHitRatio * 100).toFixed(1)}%`}
                  sub="cache hit"
                  warnAt={101}
                  label={`Postgres buffer cache hit ratio ${(st.cacheHitRatio * 100).toFixed(1)} percent`}
                />
                <div class={s.gaugeCap}>
                  reads served from memory<br />
                  <span class={s.gaugeFree}>&lt; 99% means disk-bound</span>
                </div>
              </div>
            ) : (
              <div class={s.noLimit}><span class={s.noLimitVal}>—</span><span>no reads yet, so there is no cache ratio to report</span></div>
            )}
          </div>

          <div class={s.kpiGrid}>
            <span class={s.kpi}><span class={s.kpiLbl}>Database size</span><span class={s.kpiVal}>{fmtBytes(st.databaseBytes)}</span></span>
            <span class={s.kpi}><span class={s.kpiLbl}>Commits</span><span class={s.kpiVal}>{fmtCount(st.commits)}</span><span class={s.kpiNote}>since stats reset</span></span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Rollbacks</span><span class={s.kpiVal}>{fmtCount(st.rollbacks)}</span>
              {rollbackNote && <span class={s.kpiNote}>{rollbackNote}</span>}
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Deadlocks</span><span class={s.kpiVal}>{fmtCount(st.deadlocks)}</span>
              {st.deadlocks !== null && <span class={`${s.kpiNote} ${st.deadlocks > 0 ? s.wn : s.ok}`}>{st.deadlocks > 0 ? 'investigate' : 'since stats reset'}</span>}
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Temp files</span><span class={s.kpiVal}>{fmtBytes(st.tempBytes)}</span>
              {st.tempBytes !== null && <span class={`${s.kpiNote} ${st.tempBytes > 0 ? s.wn : s.ok}`}>{st.tempBytes > 0 ? 'queries spilling to disk' : 'no spill to disk'}</span>}
            </span>
            <span class={s.kpi}>
              <span class={s.kpiLbl}>Longest txn</span>
              <span class={s.kpiVal}>{st.longestTxnSeconds === null ? '—' : `${st.longestTxnSeconds.toFixed(1)} s`}</span>
              {st.longestTxnSeconds !== null && st.longestTxnSeconds > 5 && <span class={`${s.kpiNote} ${s.wn}`}>watch — locks age</span>}
            </span>
          </div>

          {largestTables}
        </>
      )}
    </Card>
  );
}

function ProcessPanel({ d, sampledAgo }: { d: HealthOverview; sampledAgo: number | null }) {
  const pr = d.process;
  const heapPct = pr.heapLimitBytes > 0 ? (pr.heapUsedBytes / pr.heapLimitBytes) * 100 : 0;
  return (
    <Card>
      <div class={s.panelHead}>
        <span class={s.depIco}><Server size={13} /></span><b>Gateway process</b>
        <span class={s.panelTag}>this container</span>
        <SampledMeta sampledAgo={sampledAgo} />
      </div>
      <div class={s.procRow}>
        <div class={s.gaugeBox}>
          <RadialGauge
            pct={heapPct}
            value={`${Math.round(heapPct)}%`}
            sub="heap"
            label={`Heap ${fmtBytes(pr.heapUsedBytes)} of ${fmtBytes(pr.heapLimitBytes)} limit`}
          />
          <div class={s.gaugeCap}>
            {fmtBytes(pr.heapUsedBytes)} / {fmtBytes(pr.heapLimitBytes)}<br />
            <span class={s.gaugeFree}>V8 heap limit</span>
          </div>
        </div>

        {pr.containerLimitBytes !== null ? (
          <div class={s.gaugeBox}>
            <RadialGauge
              pct={(pr.rssBytes / pr.containerLimitBytes) * 100}
              value={`${Math.round((pr.rssBytes / pr.containerLimitBytes) * 100)}%`}
              sub="container"
              label={`Container memory ${fmtBytes(pr.rssBytes)} of ${fmtBytes(pr.containerLimitBytes)} cgroup limit`}
            />
            <div class={s.gaugeCap}>
              {fmtBytes(pr.rssBytes)} / {fmtBytes(pr.containerLimitBytes)}<br />
              <span class={s.gaugeFree}>cgroup limit, not host RAM</span>
            </div>
          </div>
        ) : (
          <div class={s.noLimit}>
            <span class={s.noLimitVal}>{fmtBytes(pr.rssBytes)}</span>
            <span>resident memory — no container memory limit detected, so no percentage is shown (host RAM would be the wrong ceiling)</span>
          </div>
        )}

        <div class={s.procGrow}>
          <div class={s.trendRow}>
            <span class={s.trendLbl}>CPU <b>{pr.cpuPct.toFixed(1)}%</b></span>
            <span class={s.sparkWide}><Sparkline points={d.series.map((x) => x.cpuPct)} label="Process CPU per minute, last hour" height={30} /></span>
          </div>
          <div class={s.trendRow}>
            <span class={s.trendLbl}>RSS <b>{fmtBytes(pr.rssBytes)}</b></span>
            <span class={s.sparkWide}><Sparkline points={d.series.map((x) => x.rssMb)} label="Resident memory per minute, last hour" height={30} /></span>
          </div>
          <div class={s.chips}>
            <span class={s.chip}>lag p50 <b>{fmtMs(pr.loopP50Ms)}</b></span>
            <span class={s.chip}>p99 <b>{fmtMs(pr.loopP99Ms)}</b></span>
            <span class={s.chip}>max 1h <b>{fmtMs(pr.loopMaxP99Ms)}</b></span>
            <span class={s.chip}>uptime <b>{fmtUptime(pr.uptimeSeconds)}</b></span>
          </div>
        </div>
      </div>
    </Card>
  );
}
