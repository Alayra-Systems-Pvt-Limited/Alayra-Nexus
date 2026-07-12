import { useState } from 'preact/hooks';
import { POST, ApiError } from '../../api';
import { Modal, Field, Input, Select, FieldRow, Button, FormError } from '../../ui';
import { ProviderFields, type ProviderConn } from './ProviderFields';

// Create a provider pool. Mirrors POST /admin/providers (providers.routes.ts). Every pool carries
// how to reach the provider AND how to read its model list (Model Fetch URL + Model ID Path), so the
// add-key "Fetch Models" step works for any provider — not just the built-in ones.
const PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter', 'custom'] as const;
const TIERS     = ['premium', 'standard', 'fast'] as const;

// Sensible starting points per provider; the operator can still override any of them. Anthropic's
// /models list requires the `anthropic-version` header, so that pool is seeded with it out of the box.
const DEFAULTS: Record<string, { baseUrl: string; authHeader: string; authPrefix: string; modelIdPath: string; extraHeaders: Record<string, string> }> = {
  openai:     { baseUrl: 'https://api.openai.com/v1',                              authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {} },
  anthropic:  { baseUrl: 'https://api.anthropic.com/v1',                           authHeader: 'x-api-key',     authPrefix: '',       modelIdPath: 'data[].id', extraHeaders: { 'anthropic-version': '2023-06-01' } },
  google:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {} },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                         authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {} },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                           authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {} },
  custom:     { baseUrl: '',                                                        authHeader: 'Authorization', authPrefix: 'Bearer', modelIdPath: 'data[].id', extraHeaders: {} },
};

const slugify = (v: string) => v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// A fresh connection block seeded from a provider's defaults (model-fetch URL is left blank — it
// falls back to base + /models).
const connFromDefaults = (p: string): ProviderConn => {
  const d = DEFAULTS[p] ?? DEFAULTS.custom;
  return { preferredModel: '', baseUrl: d.baseUrl, modelFetchUrl: '', authHeader: d.authHeader, authPrefix: d.authPrefix, modelIdPath: d.modelIdPath, extraHeaders: { ...d.extraHeaders } };
};

export function AddProviderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName]           = useState('');
  const [slug, setSlug]           = useState('');
  const [slugEdited, setSlugEd]   = useState(false);
  const [provider, setProvider]   = useState<string>('openai');
  const [tier, setTier]           = useState<string>('standard');
  const [conn, setConn]           = useState<ProviderConn>(connFromDefaults('openai'));
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Switching provider re-seeds the connection fields to that provider's defaults — the operator
  // picks the provider first, then tweaks.
  const onProvider = (value: string) => {
    setProvider(value);
    setConn(connFromDefaults(value));
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
        ...(conn.preferredModel.trim() ? { preferredModel: conn.preferredModel.trim() } : {}),
        ...(conn.baseUrl.trim() ? { baseUrl: conn.baseUrl.trim() } : {}),
        ...(conn.modelFetchUrl.trim() ? { modelFetchUrl: conn.modelFetchUrl.trim() } : {}),
        ...(conn.authHeader.trim() ? { authHeader: conn.authHeader.trim() } : {}),
        ...(conn.authPrefix.trim() ? { authPrefix: conn.authPrefix.trim() } : {}),
        ...(conn.modelIdPath.trim() ? { modelIdPath: conn.modelIdPath.trim() } : {}),
        ...(Object.keys(conn.extraHeaders).length ? { extraHeaders: conn.extraHeaders } : {}),
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

        <ProviderFields conn={conn} onChange={(patch) => setConn((c) => ({ ...c, ...patch }))} />

        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
