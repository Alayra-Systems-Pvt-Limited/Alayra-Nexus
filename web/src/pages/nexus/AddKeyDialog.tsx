import { useState } from 'preact/hooks';
import { Search, Eye, EyeOff } from 'lucide-preact';
import { POST, ApiError, fetchProviderModels, type FetchedModel } from '../../api';
import { addModelsToRegistry, type RegistryModelInput } from '../../lib/registry';
import { Modal, Field, Input, FieldRow, Button, FormError, FormNote } from '../../ui';
import { ModelPicker } from './ModelPicker';
import s from '../pages.module.css';

// Add a credential to a pool. Mirrors POST /admin/providers/:providerId/keys, and — the P7.4b piece
// — carries the model-discovery flow: "Fetch Models" calls the provider live with the entered key,
// the operator picks the models to enable (opt-in, searchable — P7.16), and on save the selected
// models join the registry with any pricing the provider's listing volunteered. The key joins the
// shared pool; per-team ownership (BYOK) is set from Teams.
export function AddKeyDialog({
  providerId, providerName, provider, tier, onClose, onChanged,
}: {
  providerId: string; providerName: string; provider: string; tier: string;
  onClose: () => void; onChanged: () => void;
}) {
  const [apiKey, setApiKey]   = useState('');
  const [showKey, setShowKey] = useState(false);
  const [label, setLabel]     = useState('');
  const [rpm, setRpm]         = useState('60');
  const [tpm, setTpm]         = useState('100000');
  const [maxUsers, setMaxUsers] = useState('1000');
  const [fetched, setFetched]   = useState<FetchedModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [fetchGen, setFetchGen] = useState(0); // keys the picker so every fetch mounts it fresh
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const canSubmit = apiKey.trim().length > 0 && !busy;

  const doFetch = async () => {
    if (!apiKey.trim()) { setError('Enter the API key first, then fetch its models.'); return; }
    setFetching(true);
    setError(null);
    try {
      const r = await fetchProviderModels(providerId, apiKey.trim());
      if (r.models.length) {
        setFetched(r.models);
        setSelected([]); // a re-fetch (new key, new provider state) must not carry stale picks
        setFetchGen((g) => g + 1); // remount the picker: search and expand state reset too
      } else {
        setError('No models returned for this key.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not fetch models.');
    } finally {
      setFetching(false);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await POST(`/admin/providers/${providerId}/keys`, {
        apiKey: apiKey.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        rpmLimit: Math.max(1, parseInt(rpm, 10) || 60),
        tpmLimit: Math.max(1, parseInt(tpm, 10) || 100000),
        maxUsers: Math.max(1, parseInt(maxUsers, 10) || 1000),
      });
      if (selected.length) {
        // Carry each picked model's harvested pricing/context into the registry entry.
        const byId = new Map(fetched.map((m) => [m.id, m]));
        const inputs: RegistryModelInput[] = selected.map((id) => {
          const m = byId.get(id);
          return {
            modelString: id,
            displayName: m?.name,
            inputCostPer1M: m?.inputCostPer1M,
            outputCostPer1M: m?.outputCostPer1M,
            contextWindow: m?.contextWindow,
          };
        });
        await addModelsToRegistry(provider, tier, inputs);
      }
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Add key · ${providerName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          {/* "Verifying" rather than "Adding": saving now calls the provider to confirm the
              credential before writing it, which takes a moment and is worth naming — a button that
              says "Adding…" for four seconds reads as a hang. */}
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>{busy ? 'Verifying…' : 'Add key'}</Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <FormError>{error}</FormError>}
        <FormNote>
          The key is encrypted before storage and only ever shown masked. It is checked against
          {' '}{providerName} before saving, so a key from a different provider is caught here rather
          than by failing requests later. Fetch its models to add them to this provider.
        </FormNote>

        <Field label="API key">
          <div class={s.keyInputRow}>
            <div class={s.keyInputWrap}>
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                placeholder="sk-…"
                onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
                autofocus
              />
              <button type="button" class={s.keyEye} onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button variant="secondary" onClick={doFetch} disabled={fetching || !apiKey.trim()}>
              <Search size={13} /> {fetching ? 'Fetching…' : 'Fetch models'}
            </Button>
          </div>
        </Field>

        {fetched.length > 0 && (
          <Field
            label={`Models (${selected.length}/${fetched.length} selected)`}
            hint="click to select — only selected models join the registry"
          >
            <ModelPicker key={fetchGen} models={fetched} selected={selected} onChange={setSelected} />
          </Field>
        )}

        <Field label="Label" hint="optional">
          <Input value={label} placeholder="primary" onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        </Field>

        <FieldRow>
          <Field label="Max users" hint="distinct users/day">
            <Input type="number" min={1} value={maxUsers} onInput={(e) => setMaxUsers((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="RPM limit" hint="per minute">
            <Input type="number" min={1} value={rpm} onInput={(e) => setRpm((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="TPM limit" hint="tokens/min">
            <Input type="number" min={1} value={tpm} onInput={(e) => setTpm((e.target as HTMLInputElement).value)} />
          </Field>
        </FieldRow>

        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
