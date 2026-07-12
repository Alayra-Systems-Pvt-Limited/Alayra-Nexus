import { useState } from 'preact/hooks';
import { PATCH, ApiError, type NexusPool } from '../../api';
import { Modal, Field, Input, Select, FieldRow, Button, FormError, FormNote } from '../../ui';
import { ProviderFields, type ProviderConn } from './ProviderFields';

const TIERS = ['premium', 'standard', 'fast'] as const;

// Edit an existing provider pool. Mirrors PATCH /admin/providers/:id. Name, tier, and the whole
// connection block are editable; the upstream provider and slug are shown read-only because changing
// either would orphan the registry models keyed by this provider's slug — a create-time decision,
// not an edit-time one.
export function EditProviderDialog({ pool, onClose, onSaved }: { pool: NexusPool; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(pool.name);
  const [tier, setTier] = useState(pool.tier);
  const [conn, setConn] = useState<ProviderConn>({
    preferredModel: pool.preferredModel ?? '',
    baseUrl:        pool.baseUrl ?? '',
    modelFetchUrl:  pool.modelFetchUrl ?? '',
    authHeader:     pool.authHeader ?? 'Authorization',
    authPrefix:     pool.authPrefix ?? '',
    modelIdPath:    pool.modelIdPath ?? 'data[].id',
    extraHeaders:   { ...(pool.extraHeaders ?? {}) },
  });
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && !busy;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await PATCH(`/admin/providers/${pool.id}`, {
        name: name.trim(),
        tier,
        // Send the connection fields as-is (trimmed). Blank base/model-fetch/prefix are allowed —
        // the gateway falls back to the provider's built-in defaults for them.
        preferredModel: conn.preferredModel.trim(),
        baseUrl:        conn.baseUrl.trim() || undefined,
        modelFetchUrl:  conn.modelFetchUrl.trim() || undefined,
        authHeader:     conn.authHeader.trim() || undefined,
        authPrefix:     conn.authPrefix.trim(),
        modelIdPath:    conn.modelIdPath.trim() || undefined,
        // Always sent (object form); an empty object clears any previously-set headers.
        extraHeaders:   conn.extraHeaders,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the provider.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit pool · ${pool.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>{busy ? 'Saving…' : 'Save pool'}</Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <FormError>{error}</FormError>}
        <FormNote>Upstream provider and slug are fixed once a pool exists — they anchor this pool's models in the registry.</FormNote>

        <FieldRow>
          <Field label="Display name">
            <Input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autofocus />
          </Field>
          <Field label="Routing tier">
            <Select value={tier} onChange={(e) => setTier((e.target as HTMLSelectElement).value)}>
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Upstream provider" hint="fixed">
            <Input value={pool.provider} disabled />
          </Field>
          <Field label="Slug" hint="fixed">
            <Input value={pool.slug} disabled />
          </Field>
        </FieldRow>

        <ProviderFields conn={conn} onChange={(patch) => setConn((c) => ({ ...c, ...patch }))} />

        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
