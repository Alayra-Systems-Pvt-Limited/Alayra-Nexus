// Typed admin API client for the dashboard. Mirrors the gateway's bearer-token contract: the
// session token lives in sessionStorage (never the password), and a 401 means the session is
// gone. This is the seam every page's data-loading is built on in later phases.

const TOKEN_KEY = 'nx_token';

export function getToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function setToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}

/** Drop the session token — on sign-out, or when the gateway rejects it as expired. */
export function clearToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    // A 401 means the session token is missing or expired: clear it and let the app fall back to the
    // login screen rather than leaving every panel stuck on "Unauthorized". A 403 (viewer hitting an
    // owner-only route) is NOT this — the session is valid, the action just isn't allowed — so it is
    // left to the calling panel to report.
    if (res.status === 401) {
      clearToken();
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nx:unauthorized'));
    }
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** The outcome of a sign-in attempt. `ok` stores the session token as a side effect. */
export interface LoginOutcome {
  ok:            boolean;
  totpRequired?: boolean;   // correct password, but a second-factor code is now required
  lockedOut?:    boolean;   // too many failed attempts
  retryAfter?:   number;    // seconds, when lockedOut
  error?:        string;
}

/**
 * Exchange the admin password (and a TOTP or recovery code, once a second factor is enrolled) for a
 * session token, stored for every subsequent request. Kept off the generic `api()` path on purpose: a
 * failed sign-in must not trip the global 401 → logout handling (there is nothing to log out of yet),
 * and it needs the parsed body to tell "wrong password" from "code required".
 */
export async function login(password: string, code?: string): Promise<LoginOutcome> {
  let res: Response;
  try {
    res = await fetch('/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(code ? { password, code } : { password }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the gateway.' };
  }
  const b = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.ok && typeof b.token === 'string') { setToken(b.token); return { ok: true }; }
  if (res.status === 429)  return { ok: false, lockedOut: true, retryAfter: Number(b.retryAfter) || undefined, error: String(b.error ?? 'Too many attempts.') };
  if (b.totpRequired)      return { ok: false, totpRequired: true, error: String(b.error ?? 'Authenticator code required.') };
  return { ok: false, error: String(b.error ?? 'Invalid credentials.') };
}

// ── Endpoint contracts ────────────────────────────────────────────────────────
// Typed shapes returned by the gateway, kept next to the client so a page and the server agree in
// one place. Mirrors GET /admin/overview (overview.service.ts).

export interface OverviewDay {
  date: string; inputTokens: number; outputTokens: number; tokens: number; usd: number; requests: number;
}

export interface Overview {
  stats: {
    totalRequests:  number;
    totalCostUsd:   number;
    inputTokens7d:  number;
    outputTokens7d: number;
    activeKeys:     number;
    activeModels:   number;
    activeTeams:    number;
  };
  series7d:   OverviewDay[];
  topModels:  { model: string; tokens: number; usd: number }[];
  topKeys:    { id: string; name: string; totalTokens: number; requests: number; estimatedUsd: number }[];
  recentLogs: { id: string; action: string; method: string; actorRole: string; status: number; target: string | null; createdAt: string }[];
}

// Mirrors GET /admin/nexus/overview (nexusOverview.service.ts).
export interface NexusKeyHealth {
  id: string; maskedKey: string; label: string | null; status: string;
  coolingUntil: string | null; rpmLimit: number; tpmLimit: number; maxUsers: number;
  ownerTeamName: string | null; lastUsedAt: string | null;
}
export interface NexusPool {
  id: string; name: string; slug: string; provider: string; tier: string;
  preferredModel: string | null;
  baseUrl: string | null; modelFetchUrl: string | null;
  authHeader: string; authPrefix: string | null; modelIdPath: string;
  extraHeaders: Record<string, string>;
  keys: NexusKeyHealth[];
}
export interface NexusOverview {
  summary: { providers: number; activeKeys: number; coolingKeys: number; bannedKeys: number; totalKeys: number };
  routing: { costWeight: number };
  tiers:   { tier: string; providers: NexusPool[] }[];
}

// Mirrors GET /admin/models (models.routes.ts) — one registry entry.
export interface AiModel {
  id: string; displayName: string; provider: string; modelString: string; tier: string; status: string;
  priority: number; capabilities: string[]; hasVision: boolean; hasFIM: boolean; hasToolCalling: boolean;
  inputCostPer1M: number; outputCostPer1M: number;
  imagePrice: number; speechPricePer1MChars: number; transcriptionPrice: number;
  audioInputPer1M: number; audioOutputPer1M: number;
  contextWindow: number; maxTokens: number;
}
export interface ModelsResponse { models: AiModel[]; capabilities: string[]; }

// Mirrors GET /admin/models/pricing-catalog (pricingCatalog.service.ts) — indicative auto-fill data.
export interface PricingCatalogEntry {
  match: string; provider: string; displayName: string; capabilities: string[];
  inputCostPer1M?: number; outputCostPer1M?: number; imagePrice?: number;
  speechPricePer1MChars?: number; transcriptionPrice?: number;
  audioInputPer1M?: number; audioOutputPer1M?: number;
  contextWindow?: number; maxTokens?: number; hasVision?: boolean; hasToolCalling?: boolean;
}

// Mirrors GET /admin/analytics/overview (analytics.service.ts) — the single read behind Analytics.
export type AnalyticsPeriod = 'today' | '7d' | '30d' | '90d';

export interface AnalyticsDay {
  date: string; requests: number; successes: number; errors: number;
  usd: number; savedUsd: number; cacheHits: number; avgLatencyMs: number;
}

export interface AnalyticsOverview {
  period: AnalyticsPeriod;
  since:  string;
  until:  string;
  totals: {
    requests: number; successes: number; errors: number; successRate: number;
    inputTokens: number; outputTokens: number; totalTokens: number; estimatedUsd: number;
    avgLatencyMs: number; p95LatencyMs: number;
    cacheHits: number; cacheHitRate: number; cacheSavedUsd: number;
  };
  byDay:      AnalyticsDay[];
  byModel:    { model: string; requests: number; tokens: number; usd: number }[];
  byProvider: { provider: string; requests: number; errors: number; tokens: number; usd: number }[];
  byModality: { unit: string; requests: number; quantity: number; tokens: number; usd: number }[];
  byOutcome:  { outcome: string; requests: number }[];
}

// ── Settings (settings.routes.ts / audit.routes.ts) ──────────────────────────
// Each config is its own GET/PUT pair, so each sub-tab loads and saves only what it owns.

export interface RoutingConfig { costWeight: number }

export interface CacheConfig { enabled: boolean; ttlSeconds: number }

// Mirrors GET /admin/cache/stats (cache.service.ts) — the operational view behind the Caching section.
export interface CacheStats {
  config:     CacheConfig;
  entries:    number;      // cached responses held in Redis right now
  windowDays: number;      // the window the `recent` figures cover
  recent: { hits: number; requests: number; hitRate: number; savedUsd: number };
}

// ── Teams (teams.routes.ts) ───────────────────────────────────────────────────
// A team groups scoped access keys and carries a per-period budget cap and a preferred routing tier.
export type TeamTier   = 'premium' | 'standard' | 'fast';
export type TeamPeriod = 'daily' | 'weekly' | 'monthly';

// Mirrors a row of GET /admin/teams — `spendUsd` is the current period's spend, computed server-side.
export interface TeamRow {
  id:           string;
  name:         string;
  status:       'active' | 'suspended';
  assignedTier: TeamTier | null;
  budgetUsd:    number | null;
  budgetPeriod: TeamPeriod;
  keyCount:     number;
  spendUsd:     number;
  createdAt:    string;
}

// The editable fields of a team (POST /admin/teams, PATCH /admin/teams/:id).
export interface TeamDraft {
  name:         string;
  status:       'active' | 'suspended';
  assignedTier: TeamTier | null;
  budgetUsd:    number | null;
  budgetPeriod: TeamPeriod;
  byokFallback: boolean;
}

// Mirrors a row of GET /admin/team-keys — a scoped access key, optionally assigned to a team.
export interface TeamKeyRow {
  id:        string;
  name:      string;
  maskedKey: string;
  team:      { id: string; name: string } | null;
  createdAt: string;
}

// ── Security (auth.routes.ts) ─────────────────────────────────────────────────
// Mirrors GET /admin/auth/status — second-factor state plus the sign-in policy facts.
export interface AuthStatus {
  twoFactorEnabled:       boolean;
  enrolmentPending:       boolean;
  recoveryCodesRemaining: number;
  sessionTtlSeconds:      number;
  maxLoginAttempts:       number;
  lockoutSeconds:         number;
}

// Mirrors a row of GET /admin/tokens — an admin API token (the plaintext is only ever seen once,
// at creation).
export interface AdminApiTokenRow {
  id: string; name: string; maskedKey: string; role: 'owner' | 'viewer';
  lastUsedAt: string | null; createdAt: string;
}

export interface GuardrailRule {
  name: string; pattern: string; flags?: string;
  action: 'block' | 'redact';
  appliesTo?: 'input' | 'output' | 'both';
  replacement?: string;
}
export interface GuardrailConfig { enabled: boolean; bufferedSafe: boolean; rules: GuardrailRule[] }

export type NotifyEvent = 'keyBanned' | 'breakerOpened' | 'adminLockout' | 'budgetThreshold' | 'tierExhausted';
export interface NotificationConfig {
  enabled: boolean; from: string; to: string[]; webhookUrl: string;
  events: Record<NotifyEvent, boolean>; windowSeconds: number;
  // The stored Resend key is never returned — only whether one is set, and its mask.
  resendKeySet: boolean; resendKeyMasked: string;
}

export interface SsrfConfig {
  allowPrivate: boolean;
  allowList: string[];
  // Supplied by the environment; shown read-only because the dashboard cannot change it.
  envAllowList: string[];
}

export interface ComplianceConfig {
  auditRetentionDays: number; usageRetentionDays: number; anonymizeUsage: boolean;
}

// Mirrors GET /admin/audit — the read-only audit trail.
export interface AuditEntry {
  id: string; action: string; method: string; actorRole: string;
  actor: string | null; target: string | null; ip: string | null;
  status: number; detail: string | null; createdAt: string;
}

// Mirrors GET /admin/config (system.routes.ts).
export interface GatewayConfig { baseUrl: string; nexusApiKey: string | null; isFirstRun: boolean; }

export const GET   = <T = unknown>(p: string) => api<T>('GET', p);
export const POST  = <T = unknown>(p: string, b?: unknown) => api<T>('POST', p, b);
export const PUT   = <T = unknown>(p: string, b?: unknown) => api<T>('PUT', p, b);
export const PATCH = <T = unknown>(p: string, b?: unknown) => api<T>('PATCH', p, b);
export const DEL   = <T = unknown>(p: string) => api<T>('DELETE', p);

/** Fetch a provider's live model list (P7.4b). `plainKey` probes before a key is saved. */
export const fetchProviderModels = (providerId: string, plainKey?: string) =>
  POST<{ models: string[] }>(`/admin/providers/${providerId}/fetch-models`, plainKey ? { plainKey } : {});
