// The gateway records an outcome slug per request. Operators should never have to read
// `upstream_error` off a dashboard, so the slugs are translated once, here, into what actually
// happened — and each carries the tone that says whether it is the provider's fault, the caller's,
// or the gateway holding a line on purpose.

export interface OutcomeMeta { label: string; help: string; tone: 'green' | 'red' | 'yellow' | 'blue' | 'gray'; }

const OUTCOMES: Record<string, OutcomeMeta> = {
  success:        { label: 'Succeeded',      tone: 'green',  help: 'Served normally.' },
  upstream_error: { label: 'Provider error', tone: 'red',    help: 'The provider failed, timed out, or dropped the stream.' },
  client_error:   { label: 'Bad request',    tone: 'yellow', help: 'The caller sent something the provider rejected.' },
  no_capacity:    { label: 'No capacity',    tone: 'red',    help: 'Every key able to serve the request was rate-limited or unavailable.' },
  budget_blocked: { label: 'Budget reached', tone: 'blue',   help: "A team hit its spend cap, so the request was refused on purpose." },
  blocked:        { label: 'Blocked',        tone: 'blue',   help: 'Content guardrails refused the request.' },
  ssrf_blocked:   { label: 'Blocked target', tone: 'blue',   help: 'The upstream address was refused by the network policy.' },
  client_cancelled: { label: 'Cancelled',    tone: 'gray',   help: 'The caller hung up before the answer finished. Tokens streamed until then are still counted.' },
};

const UNKNOWN: OutcomeMeta = { label: 'Other', tone: 'gray', help: 'An outcome this dashboard does not recognise.' };

export const outcomeMeta = (outcome: string): OutcomeMeta => OUTCOMES[outcome] ?? { ...UNKNOWN, label: outcome };

// The unit a modality is billed in. `token` is the default for chat/completions/embeddings; the
// others come from the non-token endpoints.
const MODALITIES: Record<string, { label: string; unit: string }> = {
  token:         { label: 'Text & embeddings', unit: 'tokens' },
  image:         { label: 'Image generation',  unit: 'images' },
  character:     { label: 'Speech (TTS)',      unit: 'characters' },
  transcription: { label: 'Transcription',     unit: 'files' },
};

export const modalityMeta = (unit: string) => MODALITIES[unit] ?? { label: unit, unit: 'units' };
