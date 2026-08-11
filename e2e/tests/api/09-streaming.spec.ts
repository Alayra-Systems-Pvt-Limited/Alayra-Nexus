import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack, MOCK_PROVIDER_URL } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// The two things nothing in this suite had ever reached: the Anthropic Messages endpoint, and a
// streaming response of any kind.
//
// Those gaps intersected on a bug that shipped. `/v1/messages` with `stream: true` returned a
// complete, correctly framed Anthropic stream — message_start, content_block_start,
// content_block_stop, message_stop, output_tokens 0 — with no text in it. Nothing raised, nothing
// logged; in Claude Code it read as a model that chose not to answer. The wrapper translating
// OpenAI writes into Anthropic events called `.toString()` on each chunk, which is right for the
// two paths that hand it a string (cache hit, guardrail buffering) and wrong for the one that hands
// it the `Uint8Array` read off the upstream socket, where it yields "100,97,116,97,…".
//
// It survived unit tests because the defect lived in the seam between two correct components, and
// each side's tests mocked the other. A stand-in reply can only assert what its author already
// believed about its caller, and that belief was the bug. Only real bytes on a real socket settle
// it — which is what this file is.
//
// So the assertions here are about the WORDS, never the framing. The broken version's framing was
// flawless.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

let ownerToken = '';
let masterKey  = '';

/**
 * What the mock provider streams, in `e2e/setup/mock-provider.mjs`.
 *
 * The emoji is load-bearing: the mock writes it across two socket writes, splitting the four-byte
 * sequence, so the gateway is handed a fragment it cannot decode alone. A decoder built per chunk
 * rather than held across the stream turns it into replacement characters, and this is where that
 * shows up. If the mock's script changes, this constant is what fails — which is correct.
 */
const EXPECTED = 'The mock provider streams 👋 done';

/** `data:` payloads from an SSE body, skipping the `[DONE]` sentinel. */
function dataEvents(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map((block) => block.match(/^data: (.+)$/m)?.[1])
    .filter((d): d is string => Boolean(d) && d !== '[DONE]')
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

/** Named SSE events, as Anthropic frames them: `event:` + `data:` together. */
function namedEvents(body: string): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of body.split('\n\n')) {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data  = block.match(/^data: (.+)$/m)?.[1];
    if (event && data) out.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

test.beforeAll(async () => {
  ownerToken = await gw.login(OWNER.email, OWNER.password);

  // 03 finishes by exhausting the pool key on purpose — `tpmLimit: 1`, to prove a spent token
  // budget refuses. Nothing can route until that is put back.
  const pools = await gw.get<{ providers: { id: string; slug: string }[] }>('/admin/providers', ownerToken);
  const mock  = pools.body.providers.find((p) => p.slug === 'mock');
  expect(mock, 'the mock pool from 03-proxy should still exist').toBeTruthy();

  const keys = await gw.get<{ keys: { id: string }[] }>(`/admin/providers/${mock!.id}/keys`, ownerToken);
  for (const key of keys.body.keys) {
    const restored = await gw.send('PATCH', `/admin/keys/${key.id}`, {
      token: ownerToken, body: { rpmLimit: 1000, tpmLimit: 1_000_000 },
    });
    expect(restored.status).toBe(200);
  }

  // 03 rotated the master key last thing and kept the result to itself.
  const regenerated = await gw.post<{ key: string }>('/admin/api-key/regenerate', { token: ownerToken });
  expect(regenerated.status).toBe(200);
  masterKey = regenerated.body.key;
});

test.describe('/v1/chat/completions, streaming', () => {
  test('delivers the words, not just the frames', async () => {
    const res = await gw.stream('/v1/chat/completions', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', stream: true, messages: [{ role: 'user', content: 'stream please' }] },
    });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');

    const text = dataEvents(res.text)
      .map((e) => {
        const choice = (e.choices as { delta?: { content?: string } }[] | undefined)?.[0];
        return choice?.delta?.content ?? '';
      })
      .join('');

    expect(text).toBe(EXPECTED);
  });

  test('carries a multi-byte character split across socket writes intact', async () => {
    const res = await gw.stream('/v1/chat/completions', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', stream: true, messages: [{ role: 'user', content: 'emoji please' }] },
    });

    expect(res.text).toContain('👋');
    // The failure this guards is not an exception — it is a replacement character delivered as
    // though it were the model's own output.
    expect(res.text).not.toContain('�');
  });

  test('reaches the upstream exactly once, with the pool credential', async () => {
    const before = await (await fetch(`${MOCK_PROVIDER_URL}/__requests`)).json() as { count: number };

    await gw.stream('/v1/chat/completions', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', stream: true, messages: [{ role: 'user', content: 'once' }] },
    });

    const after = await (await fetch(`${MOCK_PROVIDER_URL}/__requests`)).json() as {
      count: number; requests: { authorization: string | null }[];
    };
    expect(after.count).toBe(before.count + 1);
    // A streaming request is still a proxied request: our door opens with the caller's key, theirs
    // with the pool's.
    expect(after.requests[after.requests.length - 1].authorization).toBe('Bearer sk-mock-upstream-secret');
    expect(JSON.stringify(after.requests)).not.toContain(masterKey);
  });
});

test.describe('/v1/messages, the endpoint nothing had ever called', () => {
  test('answers a non-streaming request in Anthropic shape', async () => {
    const res = await gw.post<{
      type?: string; role?: string;
      content?: { type: string; text: string }[];
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
      error?: unknown;
    }>('/v1/messages', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.role).toBe('assistant');
    // Anthropic returns content as an array of blocks, not a string. A gateway that forwarded the
    // OpenAI shape unchanged would fail here rather than at the SDK, which is the point.
    expect(res.body.content?.[0]?.type).toBe('text');
    expect(res.body.content?.[0]?.text).toContain('mock provider answers');
    expect(res.body.usage?.input_tokens).toBe(7);
    expect(res.body.usage?.output_tokens).toBe(5);
  });

  test('streams the words — the regression that shipped', async () => {
    const res = await gw.stream('/v1/messages', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'stream please' }] },
    });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');

    const events = namedEvents(res.text);

    // First, the assertion that would have caught it. The broken build produced every other event
    // in this stream, correctly ordered and correctly shaped; what it could not produce was a
    // single delta.
    const deltas = events.filter((e) => e.event === 'content_block_delta');
    expect(deltas.length).toBeGreaterThan(0);

    const text = deltas.map((e) => (e.data.delta as { text?: string }).text ?? '').join('');
    expect(text).toBe(EXPECTED);
    expect(text).not.toContain('�');
  });

  test('frames that text as a well-formed Anthropic stream', async () => {
    // Only meaningful after the assertion above. On its own this passes against a build that
    // delivers nothing at all, which is precisely how the bug went unnoticed.
    const res = await gw.stream('/v1/messages', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'framing' }] },
    });

    const names = namedEvents(res.text).map((e) => e.event);
    expect(names[0]).toBe('message_start');
    expect(names).toContain('content_block_start');
    expect(names).toContain('content_block_stop');
    expect(names[names.length - 1]).toBe('message_stop');
  });

  test('reports tokens rather than zero for a stream that carried text', async () => {
    // `output_tokens: 0` alongside real content was the visible symptom of the empty stream, and it
    // is the number a customer's cost report is built from.
    const res = await gw.stream('/v1/messages', {
      token: masterKey,
      body: { model: 'alayra-nexus-1', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'usage' }] },
    });

    const delta = namedEvents(res.text).find((e) => e.event === 'message_delta');
    const usage = delta?.data.usage as { output_tokens?: number } | undefined;
    expect(usage?.output_tokens).toBeGreaterThan(0);
  });
});
