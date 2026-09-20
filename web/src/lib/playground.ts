import { clearToken, getToken } from '../api';

export interface PlaygroundModel {
  id: string;
  displayName: string;
  provider: string;
  auto: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface PlaygroundModelsResponse {
  models: PlaygroundModel[];
}

export type PlaygroundPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown }
  | { type: 'file'; source: unknown };

export interface PlaygroundMessage {
  role: 'system' | 'user' | 'assistant';
  content: Array<Extract<PlaygroundPart, { type: 'text' }>>;
}

export interface PlaygroundRunInput {
  model: string;
  messages: PlaygroundMessage[];
  temperature: number;
  maxTokens: number;
}

export interface PlaygroundResult {
  response: {
    status: number;
    headers: Record<string, string>;
    payload?: unknown;
    streamed: boolean;
    truncated: boolean;
  };
  trace: {
    route?: { modelString: string; provider: string };
    refusal?: { status: number; reason: string };
    outcome?: string;
  };
}

export interface PlaygroundRunCallbacks {
  onDelta(delta: string): void;
  onResult(result: PlaygroundResult): void;
}

function readableError(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    try { return readableError(JSON.parse(value), value || fallback); } catch { return value || fallback; }
  }
  if (value && typeof value === 'object') {
    const body = value as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  return fallback;
}

export function createOpenAIStreamParser(onDelta: (delta: string) => void) {
  let pending = '';

  const line = (raw: string) => {
    const value = raw.trim();
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (!data || data === '[DONE]') return;

    const parsed = JSON.parse(data) as {
      error?: { message?: string };
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    if (parsed.error?.message) throw new Error(parsed.error.message);
    const content = parsed.choices?.[0]?.delta?.content;
    if (typeof content === 'string') onDelta(content);
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          onDelta(part.text);
        }
      }
    }
  };

  return {
    push(chunk: string) {
      pending += chunk.replace(/\r\n/g, '\n');
      let split = pending.indexOf('\n');
      while (split !== -1) {
        line(pending.slice(0, split));
        pending = pending.slice(split + 1);
        split = pending.indexOf('\n');
      }
    },
    end() {
      if (pending) line(pending);
      pending = '';
    },
  };
}

function parseOuterEvent(block: string): { name: string; data: unknown } | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { name, data: JSON.parse(data.join('\n')) };
}

export async function runPlayground(
  input: PlaygroundRunInput,
  callbacks: PlaygroundRunCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/admin/playground/run', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + getToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal,
  });

  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('nx:unauthorized'));
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    throw new Error(readableError(body, 'The Playground request failed.'));
  }

  const upstream = createOpenAIStreamParser(callbacks.onDelta);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let sawResult = false;

  const consume = (text: string) => {
    pending += text.replace(/\r\n/g, '\n');
    let split = pending.indexOf('\n\n');
    while (split !== -1) {
      const event = parseOuterEvent(pending.slice(0, split));
      pending = pending.slice(split + 2);
      split = pending.indexOf('\n\n');
      if (!event) continue;

      if (event.name === 'upstream') {
        const chunk = (event.data as { chunk?: unknown }).chunk;
        if (typeof chunk === 'string') upstream.push(chunk);
      } else if (event.name === 'result') {
        const result = event.data as PlaygroundResult;
        sawResult = true;
        upstream.end();
        callbacks.onResult(result);
        if (result.response.status >= 400) {
          throw new Error(readableError(result.response.payload, result.trace.refusal?.reason ?? 'The provider request failed.'));
        }
      }
    }
  };

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    consume(decoder.decode(next.value, { stream: true }));
  }
  consume(decoder.decode());
  upstream.end();
  if (!sawResult && !signal?.aborted) throw new Error('The Playground stream ended before its result arrived.');
}
