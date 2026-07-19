// Typed admin API client for the dashboard. Mirrors the gateway's bearer-token contract: the
// session token lives in sessionStorage (never the password), and a 401 means the session is
// gone. This is the seam every page's data-loading is built on in later phases.

const TOKEN_KEY = 'nx_token';
const IDENTITY_KEY = 'nx_identity';

export type AdminRole = 'owner' | 'admin' | 'viewer';

/** Who is signed in. `userId` is null for a session minted from an admin API token. */
export interface Identity {
  role: AdminRole;
  userId: string | null;
  name: string | null;
}

export function getToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function setToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}

/**
 * The signed-in identity (Phase 7.13a). Until now the dashboard threw away the role the gateway
 * returned at sign-in, which is why it could never hide what a viewer cannot do.
 *
 * Stored for presentation ONLY. Nothing here is a permission: every rule is enforced by the guards
 * on the server, which read the role from the account on each request. A user who edited this in
 * devtools would see more buttons and get a 403 on every one of them.
 */
export function getIdentity(): Identity | null {
  try {
    const raw = sessionStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch { return null; }
}

export function setIdentity(identity: Identity): void {
  try { sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch { /* private mode */ }
}

/** Drop the session token — on sign-out, or when the gateway rejects it as expired. */
export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(IDENTITY_KEY);
  } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}

/**
 * Pull the human sentence out of a gateway error response.
 *
 * Our routes answer `{ error: "..." }` — a sentence written for the person reading it. Fastify's own
 * failures answer `{ statusCode, code, error, message }`, where `message` is the readable part. We
 * showed the raw body for either, so a framework-level failure printed
 * `{"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY",...}` into the UI.
 */
function errorText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; statusCode?: unknown };

    // Which field holds the sentence depends on who wrote the response. Ours puts it in `error`.
    // Fastify's puts a bare status name there ("Bad Request") and the sentence in `message`, so
    // reading `error` first would show every framework failure as two useless words. `statusCode`
    // tells them apart: Fastify always sends it, our routes never do.
    const order = typeof parsed.statusCode === 'number'
      ? [parsed.message, parsed.error]
      : [parsed.error, parsed.message];

    for (const field of order) {
      if (typeof field === 'string' && field.trim()) return field;
    }
  } catch { /* not JSON — fall through to the raw text */ }
  return body.trim() || `HTTP ${status}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(path, {
    method,
    // `Content-Type: application/json` is a promise that a JSON body follows, so it may only be sent
    // when one actually does. Sending it unconditionally broke every request with nothing to send:
    // the gateway rejected them with FST_ERR_CTP_EMPTY_JSON_BODY before the route ever ran (setting
    // up two-factor, enabling a key, removing a person, marking a notification read).
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
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
    throw new ApiError(res.status, errorText(text, res.status));
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

/** Store what the gateway said about who just signed in. */
function rememberIdentity(b: Record<string, unknown>): void {
  const user = b.user as { id?: string; name?: string } | null | undefined;
  setIdentity({
    role:   (b.role as AdminRole) ?? 'viewer',
    userId: user?.id ?? null,
    name:   user?.name ?? null,
  });
}

/**
 * Exchange an email and password (and a TOTP or recovery code, once a second factor is enrolled) for
 * a session token, stored for every subsequent request. Kept off the generic `api()` path on purpose:
 * a failed sign-in must not trip the global 401 → logout handling (there is nothing to log out of
 * yet), and it needs the parsed body to tell "wrong password" from "code required".
 *
 * `email` is optional because a gateway that has not been claimed yet signs in exactly as it did
 * before accounts existed: the master password alone.
 */
export async function login(password: string, code?: string, email?: string): Promise<LoginOutcome> {
  let res: Response;
  try {
    res = await fetch('/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password, ...(code ? { code } : {}), ...(email ? { email } : {}) }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the gateway.' };
  }
  const b = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.ok && typeof b.token === 'string') {
    setToken(b.token);
    rememberIdentity(b);
    return { ok: true };
  }
  if (res.status === 429)  return { ok: false, lockedOut: true, retryAfter: Number(b.retryAfter) || undefined, error: String(b.error ?? 'Too many attempts.') };
  if (b.totpRequired)      return { ok: false, totpRequired: true, error: String(b.error ?? 'Authenticator code required.') };
  return { ok: false, error: String(b.error ?? 'Invalid credentials.') };
}

// ── First run (Phase 7.13a) ───────────────────────────────────────────────────

export interface ClaimStatus {
  unclaimed: boolean;
  carriesExistingTwoFactor: boolean;
}

/**
 * Has anyone claimed this gateway? Read before the sign-in form renders, and deliberately off the
 * `api()` path: there is no session to lose, and a network failure here must not look like a logout.
 * A gateway we cannot ask is assumed CLAIMED — showing a stranger a "create the owner account"
 * screen because a fetch failed would be the worst possible way to be wrong.
 */
export async function fetchClaimStatus(): Promise<ClaimStatus> {
  try {
    const res = await fetch('/admin/setup/status');
    if (!res.ok) return { unclaimed: false, carriesExistingTwoFactor: false };
    return (await res.json()) as ClaimStatus;
  } catch {
    return { unclaimed: false, carriesExistingTwoFactor: false };
  }
}

export interface ClaimOutcome {
  ok: boolean;
  recoveryKey?: string;
  twoFactorCarriedOver?: boolean;
  error?: string;
}

/** Create the first owner account, proving control with the server's ADMIN_PASSWORD. */
export async function claimGateway(input: {
  masterPassword: string; name: string; email: string; password: string;
}): Promise<ClaimOutcome> {
  let res: Response;
  try {
    res = await fetch('/admin/setup/claim', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: 'Could not reach the gateway.' };
  }
  const b = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.ok && typeof b.token === 'string') {
    setToken(b.token);
    rememberIdentity({ role: b.role, user: b.user });
    return {
      ok: true,
      recoveryKey: String(b.recoveryKey ?? ''),
      twoFactorCarriedOver: !!b.twoFactorCarriedOver,
    };
  }
  return { ok: false, error: String(b.error ?? 'Could not create your account.') };
}

/** Reset a forgotten password with a recovery key. Returns the replacement key, shown once. */
export async function recoverPassword(input: {
  email: string; recoveryKey: string; newPassword: string;
}): Promise<{ ok: boolean; recoveryKey?: string; error?: string }> {
  let res: Response;
  try {
    res = await fetch('/admin/auth/recover', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: 'Could not reach the gateway.' };
  }
  const b = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.ok) return { ok: true, recoveryKey: String(b.recoveryKey ?? '') };
  return { ok: false, error: String(b.error ?? 'That email and recovery key do not match an active account.') };
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
  recentLogs: { id: string; action: string; method: string; actorRole: string; actorName: string | null; status: number; target: string | null; createdAt: string }[];
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

// Mirrors src/lib/modelPath.ts FetchedModel — one model from a provider's live /models listing,
// with whatever pricing/context metadata the response volunteered (already converted to per-1M).
export interface FetchedModel {
  id: string;
  name?: string;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  contextWindow?: number;
}

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
// What a team does at its budget cap (Phase 7.10): a hard block, a soft alert-only cap, or a
// downgrade to the cheapest tier so it keeps working at lower cost.
export type TeamOverBudgetAction = 'block' | 'notify' | 'downgrade';

// Mirrors a row of GET /admin/teams — `spendUsd` is the current period's spend, computed server-side.
export interface TeamRow {
  id:           string;
  name:         string;
  status:       'active' | 'suspended';
  assignedTier: TeamTier | null;
  budgetUsd:    number | null;
  budgetPeriod: TeamPeriod;
  overBudgetAction: TeamOverBudgetAction;
  // Optional only for rows cached from servers that predate the field being returned; the edit
  // modal must seed from this, never from a default (a default rewrote BYOK isolation on edit).
  byokFallback?: boolean;
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
  overBudgetAction: TeamOverBudgetAction;
  byokFallback: boolean;
}

// ── Team Stats (GET /admin/teams/:id/stats — teamStats.service.ts) ─────────────
// Per-team analytics over a viewing window, plus the per-key ("member") breakdown.
export type TeamStatsPeriod = 'today' | '7d' | '30d' | '90d';

export interface TeamStatsMember {
  id: string; name: string; maskedKey: string;
  requests: number; tokens: number; usd: number; lastUsedAt: string | null;
}

export interface TeamStats {
  team: {
    id: string; name: string; status: string;
    assignedTier: TeamTier | null; overBudgetAction: TeamOverBudgetAction;
    budgetUsd: number | null; budgetPeriod: TeamPeriod;
    budgetSpendUsd: number;   // spend in the current budget window — what admission enforces
    keyCount: number;
  };
  period: TeamStatsPeriod;
  since:  string;
  until:  string;
  totals: {
    requests: number; successes: number; errors: number; successRate: number;
    totalTokens: number; estimatedUsd: number; avgLatencyMs: number;
  };
  byDay:   { date: string; requests: number; usd: number; tokens: number }[];
  byModel: { model: string; requests: number; tokens: number; usd: number }[];
  members: TeamStatsMember[];
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
  id: string; name: string; maskedKey: string; role: AdminRole;
  lastUsedAt: string | null; createdAt: string;
  /** Who minted it (Phase 7.13a). Null for a token created before accounts, or by a removed account. */
  createdBy: string | null;
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
  /** How long the in-app alert feed is kept (Phase 7.11). 0 = keep forever. */
  notificationRetentionDays: number;
}

// ── Notifications feed (notifications.routes.ts) ──────────────────────────────
// The bell's alerts. Recorded whenever the gateway raises one, independently of whether email or a
// webhook is configured — those gate delivery, not whether an alert is noticed at all.
export type NotificationSeverity = 'critical' | 'warning' | 'info';
export interface NotificationRow {
  id: string;
  /** NotifyEventType — keyBanned | breakerOpened | adminLockout | budgetThreshold | tierExhausted. */
  type: string;
  /** How loud it is (7.16c) — drives the icon tint. Older rows without one read as 'info'. */
  severity: NotificationSeverity;
  title: string; body: string;
  /** The section that raised it, for click-through. Null for an alert with no obvious home. */
  section: string | null;
  read: boolean;
  createdAt: string;
}
export interface NotificationsFeed {
  notifications: NotificationRow[];
  /** Over every unread alert, not just the page returned. */
  unreadCount: number;
}

// ── Branding (branding.routes.ts) ─────────────────────────────────────────────
// The operator's own name and logo. Read from the PUBLIC `GET /branding` — the sign-in screen shows
// it before any session exists. The logo is a data URI served from this origin, never a remote URL.
export interface Branding {
  companyName: string;
  logoDataUri: string;
}

// Mirrors GET /admin/audit — the read-only audit trail.
export interface AuditEntry {
  id: string; action: string; method: string; actorRole: string;
  actor: string | null; target: string | null; ip: string | null;
  status: number; detail: string | null; createdAt: string;
  /** Who, by name (Phase 7.13a) — copied onto the record so it survives the account. Null when
   *  there is genuinely nobody: a token-minted session, or an action from before accounts. */
  actorName: string | null;
}

// ── Health (health.routes.ts / GET /ready — healthSampler.service.ts) ─────────
// The gateway's own vitals: live probes of Redis/Postgres/the event loop, sampled every 15s into an
// in-memory hour of history. Every figure is measured; anything unknowable is null, never invented.
export type HealthStatus = 'healthy' | 'degraded' | 'down';
export type StripCell    = HealthStatus | 'none';

export interface ReadyCheck {
  id: 'redis' | 'postgres' | 'eventLoop' | 'heap';
  label: string; measured: string; threshold: string; status: HealthStatus;
}

export interface HealthMinutePoint {
  ts: number; redisMs: number | null; pgMs: number | null;
  cpuPct: number; rssMb: number; loopP99Ms: number;
}

export interface RedisInfoStats {
  version: string | null; uptimeSeconds: number | null;
  connectedClients: number | null; blockedClients: number | null;
  usedMemoryBytes: number | null; maxMemoryBytes: number | null; // null = no maxmemory set — no % exists
  fragmentationRatio: number | null; opsPerSec: number | null;
  keyspaceHits: number | null; keyspaceMisses: number | null;
  evictedKeys: number | null; expiredKeys: number | null;
}

export interface PgHealthStats {
  version: string | null; maxConnections: number | null;
  connections: { total: number; active: number; idle: number } | null;
  cacheHitRatio: number | null; commits: number | null; rollbacks: number | null;
  deadlocks: number | null; tempBytes: number | null; databaseBytes: number | null;
  longestTxnSeconds: number | null;
  largestTables: { name: string; rows: number; bytes: number }[];
}

export interface HealthOverview {
  status: HealthStatus; summary: string; checks: ReadyCheck[]; ready: boolean;
  strip: StripCell[]; series: HealthMinutePoint[];
  window: { minutes: number; samples: number; capacity: number };
  sampledAt: string | null;
  redis: {
    up: boolean; pingMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
    info: RedisInfoStats | null; hitRate: number | null;
  };
  postgres: {
    up: boolean; queryMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
    stats: PgHealthStats | null;
  };
  process: {
    node: string; uptimeSeconds: number; pid: number;
    loopP50Ms: number; loopP99Ms: number; loopMaxP99Ms: number | null;
    cpuPct: number; rssBytes: number;
    heapUsedBytes: number; heapLimitBytes: number;
    containerLimitBytes: number | null;
  };
}

// Mirrors GET /admin/config (system.routes.ts).
// `nexusApiKey` is gone as of Phase 7.13a: the key is stored as a hash, so the gateway has nothing
// to send. What is left is the hint and whether one is set.
export interface GatewayConfig {
  baseUrl: string;
  /** Which authority produced baseUrl (P7.14): the PUBLIC_URL pin, the proxy's forwarded
   *  headers, or a bare Host-header guess. The Connect page uses this to explain itself
   *  when the browser's own address bar disagrees. */
  baseUrlSource: 'env' | 'proxy' | 'host';
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  isFirstRun: boolean;
}

// ── Accounts (Phase 7.13a) ────────────────────────────────────────────────────

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: 'active' | 'suspended';
  source: 'local' | 'sso';
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleInfo { label: string; description: string }
export type RoleCatalogue = Record<AdminRole, RoleInfo>;

export interface AdminUsersResponse { users: AdminUserRow[]; roles: RoleCatalogue }

export interface AdminInviteRow {
  id: string;
  email: string;
  role: AdminRole;
  expiresAt: string;
  expired: boolean;
  invitedBy: string | null;
  createdAt: string;
}

export interface AdminInvitesResponse { invites: AdminInviteRow[]; ttlDays: number }

/** Mirrors GET /admin/me. `account` is null for a session minted from an admin API token. */
export interface MeResponse { account: AdminUserRow | null; role: AdminRole }

/** One signed-in session, as GET /admin/me/sessions reports it (Phase 7.13b). */
export interface SessionRow {
  id:         string;   // an HMAC of the token — names the session without being usable as one
  browser:    string;   // "Chrome on Windows" — descriptive only, any client can claim any agent
  userAgent:  string;
  ip:         string | null;
  createdAt:  number;   // epoch ms
  lastSeenAt: number;   // epoch ms, refreshed at most once a minute
  current:    boolean;  // the session making this request
}

export interface SessionsResponse { sessions: SessionRow[] }

export const GET   = <T = unknown>(p: string) => api<T>('GET', p);
export const POST  = <T = unknown>(p: string, b?: unknown) => api<T>('POST', p, b);
export const PUT   = <T = unknown>(p: string, b?: unknown) => api<T>('PUT', p, b);
export const PATCH = <T = unknown>(p: string, b?: unknown) => api<T>('PATCH', p, b);
export const DEL   = <T = unknown>(p: string) => api<T>('DELETE', p);

/** Fetch a provider's live model list (P7.4b). `plainKey` probes before a key is saved.
 *  Since P7.16 each entry carries harvested pricing/context metadata, not just the id. */
export const fetchProviderModels = (providerId: string, plainKey?: string) =>
  POST<{ models: FetchedModel[] }>(`/admin/providers/${providerId}/fetch-models`, plainKey ? { plainKey } : {});
