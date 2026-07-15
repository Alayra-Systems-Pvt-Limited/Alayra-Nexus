import { useState } from 'preact/hooks';
import { Eye, EyeOff } from 'lucide-preact';
import { PATCH, ApiError, type NexusKeyHealth } from '../../api';
import { Modal, Field, Input, FieldRow, Button, FormError, FormNote } from '../../ui';
import s from '../pages.module.css';

// Edit an existing key: its label, the three limits, and — optionally — the credential itself.
// Mirrors PATCH /admin/keys/:id. Leaving "Replace API key" blank keeps the stored key untouched;
// the edit never changes the key's health (ban/cool state), which stays with the row actions.
export function EditKeyDialog({ k, onClose, onSaved }: { k: NexusKeyHealth; onClose: () => void; onSaved: () => void }) {
  const formId                  = `edit-key-form-${k.id}`;
  const [label, setLabel]       = useState(k.label ?? '');
  const [rpm, setRpm]           = useState(String(k.rpmLimit));
  const [tpm, setTpm]           = useState(String(k.tpmLimit));
  const [maxUsers, setMaxUsers] = useState(String(k.maxUsers));
  const [apiKey, setApiKey]     = useState('');
  const [showKey, setShowKey]   = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    // Fall back to the stored limit only when the field can't be parsed at all. Using `|| k.rpmLimit`
    // would also reject a typed `0` (falsy) and silently keep the old value; clamp it to 1 instead.
    const parsedRpm      = parseInt(rpm, 10);
    const parsedTpm      = parseInt(tpm, 10);
    const parsedMaxUsers = parseInt(maxUsers, 10);
    try {
      await PATCH(`/admin/keys/${k.id}`, {
        label:    label.trim(),
        rpmLimit: Math.max(1, Number.isNaN(parsedRpm) ? k.rpmLimit : parsedRpm),
        tpmLimit: Math.max(1, Number.isNaN(parsedTpm) ? k.tpmLimit : parsedTpm),
        maxUsers: Math.max(1, Number.isNaN(parsedMaxUsers) ? k.maxUsers : parsedMaxUsers),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit key · ${k.maskedKey}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Save key'}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        {error && <FormError>{error}</FormError>}

        <Field label="Label" hint="optional">
          <Input value={label} placeholder="primary" onInput={(e) => setLabel((e.target as HTMLInputElement).value)} autofocus />
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

        <Field label="Replace API key" hint="optional — leave blank to keep the current key">
          <div class={s.keyInputWrap}>
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder="sk-…"
              onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
            <button type="button" class={s.keyEye} onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}>
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>
        <FormNote>
          A replaced key is re-encrypted and re-masked; the old value is discarded. Max users caps how many
          distinct end-users this key serves per day, and applies only to requests that identify their user.
        </FormNote>
      </form>
    </Modal>
  );
}
