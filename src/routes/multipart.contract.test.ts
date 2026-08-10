import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

// ── The @fastify/multipart contract the transcription route depends on ────────────────────────
//
// `/v1/audio/transcriptions` is the only upload path in the gateway, and it is the only route whose
// body is not JSON. It reads `request.parts()`, buffers the file part, and pulls `model` out of the
// fields so Nexus can substitute the model it routed to. None of that is covered: the backup
// restore upload is exercised end to end, but it goes through `isMultipart()` and never touches
// `parts()`, and the transcription route has no test at all.
//
// That gap is why the 9→10 bump could not be judged on the changelog alone. So this drives the real
// plugin, registered with the gateway's own limits, through the same shape of loop the route uses.
//
// A contract test rather than a route test on purpose: the route's own logic did not change, the
// plugin did. What is asserted here is exactly what a major version could take away — that
// `parts()` yields file parts before/among field parts, that `toBuffer()` returns the bytes intact,
// that `part.value` reads a field, and that `limits.fileSize` still refuses an oversized upload
// instead of buffering it into memory.

/** The gateway's own configuration — see src/server.ts. Small file cap here so the limit is testable. */
const MAX_BYTES = 1024;

interface Collected {
  fileBytes: number | null;
  fileHash: string;
  filename: string;
  mimetype: string;
  model: string;
  fields: Record<string, string>;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  app.post('/upload', async (request, reply) => {
    // Deliberately the same shape as src/routes/proxy.ts's transcription handler.
    let fileBuf: Buffer | null = null;
    let filename = 'audio';
    let mimetype = 'application/octet-stream';
    let model    = '';
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuf  = await part.toBuffer();
          filename = part.filename || filename;
          mimetype = part.mimetype || mimetype;
        } else if (part.fieldname === 'model') {
          model = String(part.value);
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      // The plugin signals an over-limit upload by throwing out of the iterator.
      return reply.code(413).send({ error: (err as Error).name });
    }
    if (!fileBuf) return reply.code(400).send({ error: 'no file part' });
    const body: Collected = {
      fileBytes: fileBuf.length,
      fileHash: fileBuf.subarray(0, 4).toString('hex'),
      filename, mimetype, model, fields,
    };
    return reply.send(body);
  });

  await app.ready();
});

afterAll(async () => { await app.close(); });

/** A real multipart/form-data body — built by hand so the test does not depend on the encoder too. */
function form(parts: { name: string; value?: string; file?: Buffer; filename?: string; type?: string }[]) {
  const boundary = '----nexustest' + '0'.repeat(8);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = p.file !== undefined
      ? `form-data; name="${p.name}"; filename="${p.filename ?? 'a.bin'}"`
      : `form-data; name="${p.name}"`;
    const head = `--${boundary}\r\nContent-Disposition: ${disp}\r\n`
      + (p.file !== undefined ? `Content-Type: ${p.type ?? 'application/octet-stream'}\r\n` : '')
      + '\r\n';
    chunks.push(Buffer.from(head), p.file ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), boundary };
}

const post = async (parts: Parameters<typeof form>[0]) => {
  const { payload, boundary } = form(parts);
  return app.inject({
    method: 'POST', url: '/upload', payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
};

describe('reading an upload the way the transcription route does', () => {
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]); // "RIFF" + payload

  it('yields the file part with its bytes, name and type intact', async () => {
    const res = await post([{ name: 'file', file: audio, filename: 'speech.wav', type: 'audio/wav' }]);
    expect(res.statusCode).toBe(200);
    const body = res.json<Collected>();
    expect(body.fileBytes).toBe(audio.length);
    // The first four bytes, not just the length: a plugin that re-encoded or trimmed the stream
    // would still produce a plausible byte count.
    expect(body.fileHash).toBe('52494646');
    expect(body.filename).toBe('speech.wav');
    expect(body.mimetype).toBe('audio/wav');
  });

  it('reads field parts alongside the file, and holds `model` back from the rest', async () => {
    // `model` is separated because Nexus substitutes the model it ROUTED to when it rebuilds the
    // form. If it leaked into `fields`, the caller's model would be forwarded twice — once as their
    // choice and once as ours — and the upstream would take whichever it saw last.
    const res = await post([
      { name: 'model', value: 'whisper-1' },
      { name: 'file', file: audio, filename: 'speech.wav', type: 'audio/wav' },
      { name: 'language', value: 'en' },
      { name: 'response_format', value: 'text' },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json<Collected>();
    expect(body.model).toBe('whisper-1');
    expect(body.fields).toEqual({ language: 'en', response_format: 'text' });
    expect(body.fileBytes).toBe(audio.length);
  });

  it('refuses a request with no file part', async () => {
    const res = await post([{ name: 'model', value: 'whisper-1' }]);
    expect(res.statusCode).toBe(400);
  });

  it('still enforces limits.fileSize rather than buffering the whole upload', async () => {
    // The reason the limit exists: `toBuffer()` puts the upload in memory, so an unbounded one is a
    // way to exhaust the gateway with a single request. If a major version ever stopped honouring
    // this option, nothing else here would notice — the request would simply succeed.
    const res = await post([{ name: 'file', file: Buffer.alloc(MAX_BYTES + 1, 7), filename: 'big.wav' }]);
    expect(res.statusCode).toBe(413);
  });
});
