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
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
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
  contextWindow: number; maxTokens: number;
}
export interface ModelsResponse { models: AiModel[]; capabilities: string[]; }

// Mirrors GET /admin/config (system.routes.ts).
export interface GatewayConfig { baseUrl: string; nexusApiKey: string | null; isFirstRun: boolean; }

export const GET  = <T = unknown>(p: string) => api<T>('GET', p);
export const POST = <T = unknown>(p: string, b?: unknown) => api<T>('POST', p, b);
export const PUT  = <T = unknown>(p: string, b?: unknown) => api<T>('PUT', p, b);
export const DEL  = <T = unknown>(p: string) => api<T>('DELETE', p);

/** Fetch a provider's live model list (P7.4b). `plainKey` probes before a key is saved. */
export const fetchProviderModels = (providerId: string, plainKey?: string) =>
  POST<{ models: string[] }>(`/admin/providers/${providerId}/fetch-models`, plainKey ? { plainKey } : {});
