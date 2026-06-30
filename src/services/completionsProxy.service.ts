import type { FastifyReply }      from 'fastify';
import { getModelById, getPrimaryModel, ModelNotFoundError, ModelPausedError } from './model.service';
import type { AiModel }           from './model.service';
import { discoverPool, recordMetric } from './nexus.service';
import { recordTokenUsage }       from './token.service';

export interface CompletionsBody {
  model?:       string;
  messages?:    unknown[];
  stream?:      boolean;
  max_tokens?:  number;
  temperature?: number;
  tools?:       unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export class ProxyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function providerUrl(model: AiModel, baseUrl?: string | null): string {
  switch (model.provider) {
    case 'google':     return 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    case 'groq':       return 'https://api.groq.com/openai/v1/chat/completions';
    case 'openai':     return `${(baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
    case 'anthropic':  return `${(baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '')}/chat/completions`;
    case 'openrouter': return `${(baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`;
    case 'custom':
      if (!baseUrl) throw new ProxyError(503, 'Custom provider base URL not configured');
      return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    default:
      throw new ProxyError(503, `Provider ${model.provider} not supported`);
  }
}

async function resolveKey(model: AiModel): Promise<{ apiKey: string; baseUrl?: string | null }> {
  const pool = await discoverPool(model.provider).catch(() => null);
  if (pool?.decryptedKey) return { apiKey: pool.decryptedKey, baseUrl: pool.baseUrl };
  throw new ProxyError(503, `No active API key for provider: ${model.provider}`);
}

function inferProvider(modelId: string): AiModel['provider'] | null {
  const m = modelId.toLowerCase();
  if (m.startsWith('claude'))                           return 'anthropic';
  if (m.startsWith('gemini') || m.startsWith('google')) return 'google';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  if (m.startsWith('llama') || m.startsWith('mixtral') || m.startsWith('deepseek') || m.includes('groq')) return 'groq';
  if (m.includes('/'))                                  return 'openrouter';  // openrouter uses "provider/model" format
  return null;
}

async function resolveModel(modelId: string | undefined): Promise<AiModel> {
  const raw = (modelId ?? '').trim();
  if (!raw || raw === 'nexus-auto') return getPrimaryModel();

  // 1. Check our registry first
  try {
    const m = await getModelById(raw);
    if (m.status !== 'active') throw new ModelPausedError(raw);
    return m;
  } catch (err) {
    if (!(err instanceof ModelNotFoundError)) throw err;
  }

  // 2. Not in registry — infer provider from model name so real Cursor model IDs work
  const provider = inferProvider(raw);
  if (!provider) throw new ProxyError(404, `Cannot infer provider for model: ${raw}. Add it to the model registry or use a recognizable model ID (claude-*, gemini-*, gpt-*, llama-*, provider/model).`);

  return {
    id:                  raw,
    provider,
    modelString:         raw,
    displayName:         raw,
    status:              'active',
    isPrimary:           false,
    isFree:              false,
    priority:            10,
    supportsVision:      false,
    supportsToolCalling: true,
    contextWindow:       128000,
    inputPricePer1k:     0,
    outputPricePer1k:    0,
  };
}

function parseUsageFromSSE(collected: string): { input: number; output: number } | null {
  const lines = collected.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (json === '[DONE]') continue;
    try {
      const parsed = JSON.parse(json) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (parsed.usage?.prompt_tokens !== undefined) {
        return { input: parsed.usage.prompt_tokens ?? 0, output: parsed.usage.completion_tokens ?? 0 };
      }
    } catch { /* skip */ }
  }
  return null;
}

function estimateDeltaTokens(collected: string): number {
  const matches = collected.match(/"delta"\s*:\s*\{[^}]*"content"\s*:\s*"([^"]*)"/g) ?? [];
  const content = matches.map(m => { try { return JSON.parse(`{${m}}`).delta?.content ?? ''; } catch { return ''; } }).join('');
  return Math.max(1, Math.ceil(content.length / 4));
}

function estimateInputTokens(messages: unknown[]): number {
  try { return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4)); } catch { return 256; }
}

export async function handleProxy(body: CompletionsBody, reply: FastifyReply): Promise<FastifyReply | void> {
  const target   = await resolveModel(body.model);
  const { apiKey, baseUrl } = await resolveKey(target);
  const upstreamUrl = providerUrl(target, baseUrl);

  const upstreamBody = { ...body, model: target.modelString };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization:  `Bearer ${apiKey}`,
  };

  const sessionId = `proxy-${Date.now()}`;
  const messages  = Array.isArray(body.messages) ? body.messages : [];
  const isStream  = body.stream === true;

  const upstream = await fetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => 'Upstream error');
    // Cool key on rate limit
    if (upstream.status === 429) {
      const pool = await discoverPool(target.provider).catch(() => null);
      if (pool) { const { coolKey } = await import('./nexus.service'); await coolKey(pool.keyId, 60); }
    }
    return reply.status(upstream.status).send(errText);
  }

  if (isStream && upstream.body) {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    let collected = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        collected += chunk;
        reply.raw.write(value);
      }
    } finally {
      reply.raw.end();
    }

    const usage        = parseUsageFromSSE(collected);
    const inputTokens  = usage?.input  ?? estimateInputTokens(messages);
    const outputTokens = usage?.output ?? estimateDeltaTokens(collected);
    void recordTokenUsage({ sessionId, model: target, inputTokens, outputTokens }).catch(() => {});
    void recordMetric('stream', inputTokens + outputTokens).catch(() => {});
    return;
  }

  const data         = await upstream.json() as Record<string, unknown>;
  const usageObj     = (data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined);
  const inputTokens  = usageObj?.prompt_tokens  ?? estimateInputTokens(messages);
  const outputTokens = usageObj?.completion_tokens ?? 1;
  void recordTokenUsage({ sessionId, model: target, inputTokens, outputTokens }).catch(() => {});
  void recordMetric('non-stream', inputTokens + outputTokens).catch(() => {});

  return reply.code(200).send(data);
}
