import { useState } from 'preact/hooks';
import { RotateCw, ShieldAlert } from 'lucide-preact';
import { POST } from '../../api';
import { Button, Modal, FormError, CopyButton } from '../../ui';
import { isOwner as ownerRole } from '../../lib/access';
import s from '../pages.module.css';

// The master API key (Phase 7.13a).
//
// This used to be a copy field with the live key in it. It is a hint and a Rotate button now, because
// the key is stored as a hash — the gateway genuinely cannot show it again, which is the point: a key
// the dashboard can display is a key a stolen database can display. Same trade Stripe, OpenAI and
// GitHub make.
//
// Rotating is destructive in a way that is easy to underestimate ("regenerate" sounds harmless), so
// it is confirmed, and the confirmation says what actually breaks.

export function ApiKeyPanel({
  apiKeySet, apiKeyMasked, onRotated,
}: {
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  onRotated: () => void;
}) {
  const isOwner = ownerRole();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const rotate = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await POST<{ key: string }>('/admin/api-key/regenerate');
      setConfirming(false);
      setFresh(r.key);
      onRotated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rotate the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class={s.keyPanel}>
        <div class={s.keyLabel}>API key</div>
        <div class={s.keyValue}>
          {apiKeySet
            ? <code class={s.keyMask}>{apiKeyMasked}</code>
            : <span class={s.keyNone}>Not set — rotate to generate one.</span>}
          {isOwner && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              <RotateCw size={13} /> Rotate
            </Button>
          )}
        </div>
        <p class={s.keyNote}>
          {apiKeySet
            ? 'Shown in full only once, when it is created. The gateway stores a fingerprint, not the key, so it cannot be displayed again — lost it? Rotate for a new one.'
            : 'A key is generated when the gateway first starts, and shown once in its logs.'}
        </p>
      </div>

      {error && <FormError>{error}</FormError>}

      {confirming && (
        <Modal
          title="Rotate the API key?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="danger" onClick={rotate} disabled={busy}>
                {busy ? 'Rotating…' : 'Rotate key'}
              </Button>
            </>
          }
        >
          <p class={s.setDesc}>
            The current key stops working <strong>immediately</strong>. Every client, script, and IDE
            using it will start failing until you give them the new one.
          </p>
          <p class={s.setDesc}>
            The new key is shown once, here, right after you confirm. There is no way to see it again
            afterwards — so be ready to save it.
          </p>
        </Modal>
      )}

      {fresh && (
        <Modal
          title="Your new API key"
          onClose={() => setFresh(null)}
          footer={<Button variant="primary" onClick={() => setFresh(null)}>I’ve saved it</Button>}
        >
          <div class={s.onceBox}>
            <div class={s.onceHead}><ShieldAlert size={15} /> This is the only time it is shown</div>
            <div class={s.onceKey}>{fresh}</div>
            <CopyButton value={fresh} label="Copy key" variant="secondary" />
          </div>
          <p class={s.setDesc}>
            The previous key no longer works. Update your clients now.
          </p>
        </Modal>
      )}
    </>
  );
}
