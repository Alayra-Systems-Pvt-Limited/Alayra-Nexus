import { useState } from 'preact/hooks';
import { POST, ApiError } from '../../api';
import { Modal, Field, Input, Select, FieldRow, Button, FormError, FormNote } from '../../ui';
import { ProviderFields, type ProviderConn } from './ProviderFields';
import { PROVIDER_PRESETS, presetFor, type ProviderPreset } from '../../lib/providers';

// Create a provider pool. Mirrors POST /admin/providers (providers.routes.ts). Every pool carries
// how to reach the provider AND how to read its model list (Model Fetch URL + Model ID Path), so the
// add-key "Fetch Models" step works for any provider — not just the built-in ones.
//
// The provider list and its per-provider defaults come from src/data/providers.ts, which the
// gateway reads too. They used to be a separate literal here, which is how this dialog came to
// offer six providers while the routing layer had default URLs for five and the key-format check
// knew a seventh.
const TIERS = ['premium', 'standard', 'fast'] as const;

const slugify = (v: string) => v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const CUSTOM = presetFor('custom')!;

// A fresh connection block seeded from a provider's preset. The model-fetch URL is normally left
// blank — it falls back to base + /models — and carried explicitly only where that fallback is
// wrong, which today is Cloudflare, whose /v1/models answers 405.
const connFromPreset = (preset: ProviderPreset): ProviderConn => ({
  preferredModel: '',
  baseUrl:        preset.baseUrl,
  modelFetchUrl:  preset.modelFetchUrl ?? '',
  authHeader:     preset.authHeader,
  authPrefix:     preset.authPrefix,
  modelIdPath:    preset.modelIdPath,
  extraHeaders:   { ...preset.extraHeaders },
});

export function AddProviderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName]           = useState('');
  const [slug, setSlug]           = useState('');
  const [slugEdited, setSlugEd]   = useState(false);
  const [provider, setProvider]   = useState<string>('openai');
  const [tier, setTier]           = useState<string>('standard');
  const [conn, setConn]           = useState<ProviderConn>(connFromPreset(presetFor('openai') ?? CUSTOM));
  const [account, setAccount]     = useState('');
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const preset = presetFor(provider);

  // Switching provider re-seeds the connection fields to that provider's defaults — the operator
  // picks the provider first, then tweaks.
  const onProvider = (value: string) => {
    setProvider(value);
    setConn(connFromPreset(presetFor(value) ?? CUSTOM));
    setAccount('');
  };

  // Some providers route per account, so their URL cannot be known in advance — Cloudflare's base
  // and catalogue URLs both contain the account id. The preset carries the placeholder token, this
  // fills it in, and `pending` is true while the token is still sitting in a URL unresolved.
  //
  // Substituting at submit rather than as-you-type keeps the token in the editable field, so the
  // operator can still see and change the URL shape; typing into the account box then keeps
  // working instead of having nothing left to replace after the first keystroke.
  const token   = preset?.accountPlaceholder?.token;
  const resolve = (url: string) => (token && account.trim() ? url.split(token).join(account.trim()) : url);
  const pending = !!token && [conn.baseUrl, conn.modelFetchUrl].some((u) => u.includes(token)) && !account.trim();

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const canSubmit = name.trim().length > 0 && effectiveSlug.length > 0 && !pending && !busy;

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
        ...(conn.baseUrl.trim() ? { baseUrl: resolve(conn.baseUrl.trim()) } : {}),
        ...(conn.modelFetchUrl.trim() ? { modelFetchUrl: resolve(conn.modelFetchUrl.trim()) } : {}),
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
              {PROVIDER_PRESETS.map((p) => <option key={p.slug} value={p.slug}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label="Routing tier">
            <Select value={tier} onChange={(e) => setTier((e.target as HTMLSelectElement).value)}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
        </FieldRow>

        {/* What this provider will and will not do, said before the pool exists rather than
            discovered later from a $0 line on the analytics page. */}
        {preset?.note && <FormNote>{preset.note}</FormNote>}
        {preset && !preset.publishesPricing && preset.slug !== 'custom' && (
          <FormNote>
            {preset.label} does not publish per-model prices, so models fetched from it arrive
            unpriced — set a price on each one, or its requests count as $0 in cost analytics.
          </FormNote>
        )}

        {preset?.accountPlaceholder && (
          <Field label={preset.accountPlaceholder.label} hint={preset.accountPlaceholder.hint}>
            <Input
              value={account}
              // A shape, not a real id. The first draft used a live account id copied from a
              // working config, which would have shipped one operator's account to every install.
              placeholder="0123456789abcdef0123456789abcdef"
              onInput={(e) => setAccount((e.target as HTMLInputElement).value)}
            />
          </Field>
        )}

        <ProviderFields conn={conn} onChange={(patch) => setConn((c) => ({ ...c, ...patch }))} />

        {/* The URL that will actually be saved, once the placeholder is filled. Shown because the
            field above still holds the token, and an operator should not have to do the
            substitution in their head to check it. */}
        {token && !pending && conn.baseUrl.includes(token) && (
          <FormNote>Base URL will be saved as <code>{resolve(conn.baseUrl)}</code></FormNote>
        )}
        {pending && (
          <FormNote>
            Fill in the {preset!.accountPlaceholder!.label.toLowerCase()} above — saving a URL with{' '}
            <code>{token}</code> still in it would fail on every request.
          </FormNote>
        )}

        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
