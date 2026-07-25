import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const get = vi.fn();
vi.mock('../api', () => ({ GET: (p: string) => get(p) }));

import { Health } from './Health';

// A realistic healthy overview. maxMemoryBytes is deliberately null in the base fixture — the
// common default install — so the "no ceiling, no percentage" honesty is the tested default.
const overview = (over: Record<string, unknown> = {}) => ({
  status: 'healthy', summary: 'All systems operational', ready: true,
  checks: [
    { id: 'redis',     label: 'Redis PING',         measured: '0.4 ms',  threshold: '< 50 ms',  status: 'healthy' },
    { id: 'postgres',  label: 'Postgres SELECT 1',  measured: '12.0 ms', threshold: '< 150 ms', status: 'healthy' },
    { id: 'eventLoop', label: 'Event-loop lag p99', measured: '7.1 ms',  threshold: '< 200 ms', status: 'healthy' },
    { id: 'heap',      label: 'Heap saturation',    measured: '35%',     threshold: '< 90%',    status: 'healthy' },
  ],
  backend: {
    mode: 'server', db: 'postgres', kv: 'redis',
    dbLabel: 'PostgreSQL', kvLabel: 'Redis',
    durable: true, summary: 'PostgreSQL + Redis', warning: null,
  },
  strip: Array(60).fill('healthy'),
  series: [{ ts: Date.now() - 60000, redisMs: 0.5, pgMs: 12, cpuPct: 3, rssMb: 240, loopP99Ms: 4 }],
  window: { minutes: 60, samples: 240, capacity: 240 },
  sampledAt: new Date().toISOString(),
  redis: {
    up: true, pingMs: 0.4, p50Ms: 0.4, p95Ms: 0.9, p99Ms: 1.6,
    hitRate: 0.987,
    info: {
      version: '7.2.4', uptimeSeconds: 1060000, connectedClients: 12, blockedClients: 0,
      usedMemoryBytes: 412 * 1048576, maxMemoryBytes: null, fragmentationRatio: 1.08,
      opsPerSec: 1240, keyspaceHits: 2100000, keyspaceMisses: 27000, evictedKeys: 0, expiredKeys: 18200,
    },
  },
  postgres: {
    up: true, queryMs: 12, p50Ms: 12, p95Ms: 30, p99Ms: 45,
    stats: {
      version: '16.2', maxConnections: 100,
      connections: { total: 14, active: 9, idle: 5 },
      cacheHitRatio: 0.994, commits: 812000, rollbacks: 1600, deadlocks: 0, tempBytes: 0,
      databaseBytes: 2.4 * 1024 ** 3, longestTxnSeconds: 1.8,
      largestTables: [
        { name: 'TokenUsage', rows: 4100000, bytes: 1.9 * 1024 ** 3 },
        { name: 'AuditLog',   rows: 212000,  bytes: 340 * 1048576 },
      ],
    },
  },
  process: {
    node: 'v22.11.0', uptimeSeconds: 4 * 86400 + 6 * 3600, pid: 1,
    loopP50Ms: 1.2, loopP99Ms: 7.1, loopMaxP99Ms: 14,
    cpuPct: 3.4, rssBytes: 240 * 1048576,
    heapUsedBytes: 180 * 1048576, heapLimitBytes: 512 * 1048576,
    containerLimitBytes: null,
  },
  ...over,
});

const nexusOverview = {
  summary: { providers: 2, activeKeys: 3, coolingKeys: 1, bannedKeys: 1, totalKeys: 5 },
  routing: { costWeight: 0.5 },
  tiers: [{
    tier: 'premium',
    providers: [{
      id: 'p1', name: 'OpenAI', slug: 'openai', provider: 'openai', tier: 'premium',
      preferredModel: null, baseUrl: null, modelFetchUrl: null,
      authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {},
      keys: [
        { id: 'k1', maskedKey: 'sk••1', label: null, status: 'active', coolingUntil: null, rpmLimit: 60, tpmLimit: 1, maxUsers: 1, ownerTeamName: null, lastUsedAt: null },
        { id: 'k2', maskedKey: 'sk••2', label: null, status: 'banned', coolingUntil: null, rpmLimit: 60, tpmLimit: 1, maxUsers: 1, ownerTeamName: null, lastUsedAt: null },
      ],
    }],
  }],
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((path: string) => {
    if (path === '/admin/health/overview') return Promise.resolve(overview());
    if (path === '/admin/nexus/overview')  return Promise.resolve(nexusOverview);
    return Promise.resolve({});
  });
});

describe('Health — Server tab', () => {
  it('shows the banner verdict, both probe results, and the readiness checks', async () => {
    render(<Health />);
    await waitFor(() => expect(screen.getByText('All systems operational')).toBeInTheDocument());
    expect(screen.getByText('GET /ready')).toBeInTheDocument();
    expect(screen.getByText('200 · ready')).toBeInTheDocument();
    expect(screen.getByText('200 · alive')).toBeInTheDocument();
    // The checks table is /ready rendered — one truth for ops and the UI.
    expect(screen.getByText('Postgres SELECT 1')).toBeInTheDocument();
    expect(screen.getAllByText('Pass')).toHaveLength(4);
  });

  it('says there is no memory percentage when Redis has no maxmemory, instead of inventing one', async () => {
    render(<Health />);
    await waitFor(() => expect(screen.getByText(/maxmemory/)).toBeInTheDocument());
    expect(screen.getByText(/no ceiling to measure against/)).toBeInTheDocument();
  });

  it('names the slow dependency and refuses traffic when one is down', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/admin/health/overview') {
        return Promise.resolve(overview({
          status: 'down', ready: false,
          summary: 'PostgreSQL is not responding · 3 of 4 checks healthy',
          checks: [
            { id: 'redis',     label: 'Redis PING',         measured: '0.4 ms',      threshold: '< 50 ms',  status: 'healthy' },
            { id: 'postgres',  label: 'Postgres SELECT 1',  measured: 'no response', threshold: '< 150 ms', status: 'down' },
            { id: 'eventLoop', label: 'Event-loop lag p99', measured: '7.1 ms',      threshold: '< 200 ms', status: 'healthy' },
            { id: 'heap',      label: 'Heap saturation',    measured: '35%',         threshold: '< 90%',    status: 'healthy' },
          ],
        }));
      }
      return Promise.resolve({});
    });
    render(<Health />);
    await waitFor(() => expect(screen.getByText('PostgreSQL is not responding')).toBeInTheDocument());
    expect(screen.getByText(/503 · Postgres SELECT 1/)).toBeInTheDocument();
    expect(screen.getByText('Fail')).toBeInTheDocument();
  });

  it('admits history is still building on a fresh process', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(path === '/admin/health/overview'
        ? overview({ window: { minutes: 60, samples: 12, capacity: 240 } })
        : {}));
    render(<Health />);
    await waitFor(() => expect(screen.getByText(/12 of 240 samples collected/)).toBeInTheDocument());
  });

  it('shows RSS without a container percentage when no cgroup limit exists', async () => {
    render(<Health />);
    await waitFor(() => expect(screen.getByText(/no container memory limit detected/)).toBeInTheDocument());
  });
});

describe('Health — Providers tab', () => {
  it('summarises upstream capacity read-only and points to Nexus for management', async () => {
    render(<Health />);
    await waitFor(() => expect(screen.getByText('All systems operational')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /providers/i }));

    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/nexus/overview'));
    await waitFor(() => expect(screen.getByText('Provider pools')).toBeInTheDocument());
    expect(screen.getByText('60% of capacity usable')).toBeInTheDocument(); // 3 of 5
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('1 active')).toBeInTheDocument();
    // Read-only: management stays in Nexus — one editor, no duplicate.
    const link = screen.getByText(/manage pools and keys in Nexus/i).closest('a');
    expect(link).toHaveAttribute('href', '/nexus');
  });
});

describe('Health — Benchmarks tab', () => {
  it('is honestly empty rather than showing numbers the gateway never measured', async () => {
    render(<Health />);
    await waitFor(() => expect(screen.getByText('All systems operational')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /benchmarks/i }));
    expect(screen.getByText('Benchmarks are not built yet.')).toBeInTheDocument();
    expect(screen.getByText(/numbers the gateway never measured/)).toBeInTheDocument();
  });
});

// The Storage card (S0). It answers "what is this gateway actually running on" — a question an
// operator otherwise has to answer from environment variables they may not be able to see.
describe('Health — Storage card', () => {
  it('names both engines on a production pairing, with no caution', async () => {
    render(<Health />);
    await waitFor(() => expect(screen.getByText('All systems operational')).toBeInTheDocument());

    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('Server mode')).toBeInTheDocument();
    expect(screen.getByText('Survives a restart')).toBeInTheDocument();
    // Postgres + Redis is the configuration with nothing to warn about.
    expect(screen.queryByText(/not for production/i)).not.toBeInTheDocument();
  });

  it('shows the caution and the reset warning when counters live in memory', async () => {
    get.mockImplementation((path: string) =>
      path.startsWith('/admin/health/overview')
        ? Promise.resolve(overview({
            backend: {
              mode: 'standalone', db: 'postgres', kv: 'memory',
              dbLabel: 'PostgreSQL', kvLabel: 'In-process memory',
              durable: false,
              summary: 'PostgreSQL + in-process memory (data is not durable)',
              warning: 'Counters and sessions are held in memory: everyone is signed out and rate-limit windows reset when the gateway restarts.',
            },
          }))
        : Promise.resolve(nexusOverview));

    render(<Health />);
    await waitFor(() => expect(screen.getByText('Storage')).toBeInTheDocument());

    expect(screen.getByText('Standalone mode')).toBeInTheDocument();
    expect(screen.getByText('Resets on restart')).toBeInTheDocument();
    expect(screen.getByText(/everyone is signed out/i)).toBeInTheDocument();
  });

  // The lesson from the Connect page: a field read during render that the payload does not carry
  // takes the whole view down. An older gateway — or the demo's frozen snapshot — has no `backend`,
  // and the rest of the tab must still render.
  it('renders the tab without the card when the gateway reports no backend', async () => {
    get.mockImplementation((path: string) => {
      if (!path.startsWith('/admin/health/overview')) return Promise.resolve(nexusOverview);
      const { backend: _omitted, ...withoutBackend } = overview() as Record<string, unknown>;
      return Promise.resolve(withoutBackend);
    });

    render(<Health />);
    await waitFor(() => expect(screen.getByText('All systems operational')).toBeInTheDocument());
    expect(screen.queryByText('Storage')).not.toBeInTheDocument();
  });
});
