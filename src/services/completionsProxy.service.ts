import type { FastifyReply }        from 'fastify';
import { discoverBestPool, coolKey, getNextCooldownSeconds } from './nexus.service';
import { recordTokenUsage }          from './token.service';

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

export async function handleProxy(body: CompletionsBody, reply: FastifyReply, teamKeyId?: string): Promise<FastifyReply | void> {
  const modelField = (body.model ?? '').trim().toLowerCase();
  if (modelField && modelField !== 'nexus' && modelField !== 'nexus-auto') {
    return reply.code(400).send({
      error: `Invalid model "${body.model}". Use model: "nexus" — Kinetic Nexus routes automatically.`,
    });
  }

  const route = await discoverBestPool();
  if (!route) {
    const retryAfter = await getNextCooldownSeconds();
    return reply
      .code(503)
      .header('Retry-After', String(retryAfter))
      .send({
        error: `All API keys are currently rate-limited. Retry in ${retryAfter}s or add more provider keys.`,
        retryAfter,
      });
  }

  const upstreamUrl  = `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const upstreamBody = { ...body, model: route.modelString };
  const authValue    = `${route.authPrefix ?? 'Bearer'} ${route.decryptedKey}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [route.authHeader]: authValue,
  };

  const messages  = Array.isArray(body.messages) ? body.messages : [];
  const isStream  = body.stream === true;
  const sessionId = `proxy-${Date.now()}`;

  const upstream = await fetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => 'Upstream error');
    if (upstream.status === 429) await coolKey(route.keyId, 60);
    return reply.code(upstream.status).send(errText);
  }

  const nexusHeaders = {
    'X-Nexus-Model':          route.modelString,
    'X-Nexus-Provider':       route.providerSlug,
    'X-Nexus-Tier':           route.tier,
    ...(route.wasDowngrade ? { 'X-Nexus-Tier-Downgrade': 'true' } : {}),
  };

  if (isStream && upstream.body) {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':          'text/event-stream; charset=utf-8',
      'Cache-Control':         'no-cache, no-transform',
      'Connection':            'keep-alive',
      'X-Accel-Buffering':    'no',
      ...nexusHeaders,
    });

    const reader    = upstream.body.getReader();
    const decoder   = new TextDecoder();
    let collected   = '';

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
    void recordTokenUsage({ sessionId, modelId: route.modelString, modelName: route.modelString, provider: route.providerSlug, inputTokens, outputTokens, nexusTeamKeyId: teamKeyId }).catch(() => {});
    return;
  }

  const data         = await upstream.json() as Record<string, unknown>;
  const usageObj     = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const inputTokens  = usageObj?.prompt_tokens     ?? estimateInputTokens(messages);
  const outputTokens = usageObj?.completion_tokens  ?? 1;
  void recordTokenUsage({ sessionId, modelId: route.modelString, modelName: route.modelString, provider: route.providerSlug, inputTokens, outputTokens, nexusTeamKeyId: teamKeyId }).catch(() => {});

  for (const [k, v] of Object.entries(nexusHeaders)) reply.header(k, v);
  return reply.code(200).send(data);
}
