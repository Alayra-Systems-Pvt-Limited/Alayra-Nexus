import { useState } from 'preact/hooks';
import { POST, ApiError } from '../../api';
import { Modal, Field, Input, Select, FieldRow, Button, FormError } from '../../ui';

// Create a provider pool. Mirrors POST /admin/providers (providers.routes.ts). Every pool carries
// how to reach the provider AND how to read its model list (Model Fetch URL + Model ID Path), so the
// add-key "Fetch Models" step works for any provider — not just the built-in ones.
const PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter', 'custom'] as const;
const TIERS     = ['premium', 'standard', 'fast'] as const;

// Sensible starting points per provider; the operator can still override any of them.
const DEFAULTS: Record<string, { baseUrl: string; authHeader: string; authPrefix: string; modelIdPath: string }> = {
  openai:     { baseUrl: 'https://api.openai.com/v1',                              authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id' },
  anthropic:  { baseUrl: 'https://api.anthropic.com/v1',                           authHeader: 'x-api-key',     authPrefix: '',       modelIdPath: 'data[].id' },
  google:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                         authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                           authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id' },
  custom:     { baseUrl: '',                                                        authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id' },
};

const slugify = (v: string) => v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function AddProviderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName]           = useState('');
  const [slug, setSlug]           = useState('');
  const [slugEdited, setSlugEd]   = useState(false);
  const [provider, setProvider]   = useState<string>('openai');
  const [tier, setTier]           = useState<string>('standard');
  const [preferredModel, setPM]   = useState('');
  const [baseUrl, setBaseUrl]     = useState(DEFAULTS.openai.baseUrl);
  const [modelFetchUrl, setMFU]   = useState('');
  const [authHeader, setAuthH]    = useState(DEFAULTS.openai.authHeader);
  const [authPrefix, setAuthP]    = useState(DEFAULTS.openai.authPrefix);
  const [modelIdPath, setMIP]     = useState(DEFAULTS.openai.modelIdPath);
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Switching provider re-seeds the connection fields to that provider's defaults — the operator
  // picks the provider first, then tweaks.
  const onProvider = (value: string) => {
    setProvider(value);
    const d = DEFAULTS[value] ?? DEFAULTS.custom;
    setBaseUrl(d.baseUrl); setAuthH(d.authHeader); setAuthP(d.authPrefix); setMIP(d.modelIdPath);
  };

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const canSubmit = name.trim().length > 0 && effectiveSlug.length > 0 && !busy;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await POST('/admin/providers', {
        name: name.trim(),
        slug: effectiveSlug,
        provider,
        tier,
        ...(preferredModel.trim() ? { preferredModel: preferredModel.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(modelFetchUrl.trim() ? { modelFetchUrl: modelFetchUrl.trim() } : {}),
        ...(authHeader.trim() ? { authHeader: authHeader.trim() } : {}),
        ...(authPrefix.trim() ? { authPrefix: authPrefix.trim() } : {}),
        ...(modelIdPath.trim() ? { modelIdPath: modelIdPath.trim() } : {}),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the provider.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add provider pool"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>{busy ? 'Creating…' : 'Create pool'}</Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <FormError>{error}</FormError>}

        <FieldRow>
          <Field label="Display name">
            <Input value={name} placeholder="OpenAI Prod" onInput={(e) => setName((e.target as HTMLInputElement).value)} autofocus />
          </Field>
          <Field label="Slug" hint="url-safe id">
            <Input
              value={effectiveSlug}
              placeholder="openai-prod"
              onInput={(e) => { setSlugEd(true); setSlug(slugify((e.target as HTMLInputElement).value)); }}
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Upstream provider">
            <Select value={provider} onChange={(e) => onProvider((e.target as HTMLSelectElement).value)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="Routing tier">
            <Select value={tier} onChange={(e) => setTier((e.target as HTMLSelectElement).value)}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
        </FieldRow>

        <Field label="Preferred model" hint="optional">
          <Input value={preferredModel} placeholder="gpt-4o" onInput={(e) => setPM((e.target as HTMLInputElement).value)} />
        </Field>

        <Field label="Base URL">
          <Input value={baseUrl} placeholder="https://api.openai.com/v1" onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
        </Field>

        <Field label="Model fetch URL" hint="optional — defaults to base + /models">
          <Input value={modelFetchUrl} placeholder="https://api.example.com/v1/models" onInput={(e) => setMFU((e.target as HTMLInputElement).value)} />
        </Field>

        <FieldRow>
          <Field label="Auth header">
            <Input value={authHeader} onInput={(e) => setAuthH((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Auth prefix" hint="optional">
            <Input value={authPrefix} placeholder="Bearer" onInput={(e) => setAuthP((e.target as HTMLInputElement).value)} />
          </Field>
        </FieldRow>

        <Field label="Model ID path" hint="where model ids live in the list response">
          <Input value={modelIdPath} placeholder="data[].id" onInput={(e) => setMIP((e.target as HTMLInputElement).value)} />
        </Field>

        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
