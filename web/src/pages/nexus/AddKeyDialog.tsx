import { useState } from 'preact/hooks';
import { Search, Eye, EyeOff, X } from 'lucide-preact';
import { POST, ApiError, fetchProviderModels } from '../../api';
import { addModelsToRegistry } from '../../lib/registry';
import { Modal, Field, Input, FieldRow, Button, FormError, FormNote } from '../../ui';
import s from '../pages.module.css';

// Add a credential to a pool. Mirrors POST /admin/providers/:providerId/keys, and — the P7.4b piece
// — carries the model-discovery flow: "Fetch Models" calls the provider live with the entered key,
// the operator prunes the returned list, and on save the kept models are written into the registry
// for this provider. The key joins the shared pool; per-team ownership (BYOK) is set from Teams.
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
  const [models, setModels]   = useState<string[]>([]);
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
      if (r.models.length) setModels(r.models);
      else setError('No models returned for this key.');
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
      if (models.length) await addModelsToRegistry(provider, tier, models);
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
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>{busy ? 'Adding…' : 'Add key'}</Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <FormError>{error}</FormError>}
        <FormNote>The key is encrypted before storage and only ever shown masked. Fetch its models to add them to this provider.</FormNote>

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

        {models.length > 0 && (
          <Field label={`Models (${models.length})`} hint="× to drop before saving">
            <div class={s.modelChips}>
              {models.map((m) => (
                <span key={m} class={s.modelChip}>
                  <span>{m}</span>
                  <button type="button" onClick={() => setModels((prev) => prev.filter((x) => x !== m))} aria-label={`Remove ${m}`}><X size={11} /></button>
                </span>
              ))}
            </div>
          </Field>
        )}

        <Field label="Label" hint="optional">
          <Input value={label} placeholder="primary" onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        </Field>

        <FieldRow>
          <Field label="Max users">
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
