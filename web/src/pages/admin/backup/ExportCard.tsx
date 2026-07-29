import { useState } from 'preact/hooks';
import { Download, ShieldCheck, KeyRound } from 'lucide-preact';
import { Card, Button, Field, PasswordInput, FormError, Toggle } from '../../../ui';
import { downloadBackup, RestoreError } from '../../../lib/backupClient';
import s from './backup.module.css';

// Taking a backup (Phase B1.4).
//
// One field and one button, because that is genuinely all it is — but the two sentences around them
// are load-bearing. An operator has to leave here understanding that the passphrase is the ONLY way
// back into this file, since the gateway keeps no copy of it and cannot be asked for one. A form
// that merely accepted the passphrase without saying so would produce unopenable backups, discovered
// on the day they were needed.

/** Mirrors passphraseProblem in lib/backup/format.ts. Duplicated, deliberately — see below. */
const MIN = 12;
const MAX = 200;

/**
 * Why the rule is repeated here rather than asked of the server.
 *
 * The server checks this on every request and is the authority; nothing below is trusted. But an
 * operator typing a passphrase deserves to be told at the eleventh character, not after uploading —
 * and there is no endpoint that answers "would you accept this?" without also doing the work. The
 * cost of the copy is that the two could drift, so the constant and the wording both name the same
 * requirement, and the server's refusal is still rendered verbatim if they ever disagree.
 */
function problem(passphrase: string): string | null {
  if (passphrase.length === 0) return null;   // not an error yet, just unfinished
  if (passphrase.length < MIN) return `Use at least ${MIN} characters — ${MIN - passphrase.length} to go.`;
  if (passphrase.length > MAX) return `Keep it under ${MAX} characters.`;
  return null;
}

export function ExportCard() {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [gatewayCanOpen, setGatewayCanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const tooShort = problem(passphrase);
  // Checked here and not on the server, because the server only ever sees one of them. A typo in a
  // passphrase that is never stored anywhere produces a file nobody can open, and nothing later in
  // the system can detect that — which is exactly why it is worth a second field.
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = passphrase.length >= MIN && passphrase.length <= MAX && confirm === passphrase;

  const run = async () => {
    if (busy || !ready) return;
    setBusy(true); setError(null); setSaved(null);
    try {
      const filename = await downloadBackup(passphrase, gatewayCanOpen);
      setSaved(filename);
      setPassphrase(''); setConfirm('');
    } catch (err) {
      const message = err instanceof RestoreError && err.hint ? `${err.message} ${err.hint}` : null;
      setError(message ?? (err instanceof Error ? err.message : 'The gateway could not write a backup.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div class={s.cardHead}>
        <span class={s.cardIcon}><Download size={16} /></span>
        <div>
          <h3 class={s.cardTitle}>Take a backup</h3>
          <p class={s.cardSub}>
            One encrypted file holding everything this gateway knows — providers and their keys,
            teams, people, settings, usage history and the audit trail. It is encrypted in the
            gateway and decrypted in the gateway, so nothing readable ever touches a disk in between.
          </p>
        </div>
      </div>

      {error && <FormError>{error}</FormError>}

      {saved && (
        <div class={s.doneNote} role="status">
          <ShieldCheck size={15} />
          <span>
            Saved as <code>{saved}</code>. Keep it somewhere the gateway is not — a backup on the same
            disk as the gateway is lost by the same accident.
          </span>
        </div>
      )}

      <div class={s.exportForm}>
        <Field
          label="Backup passphrase"
          hint="At least 12 characters. This is the only way to open the file — the gateway keeps no copy and cannot recover it for you."
        >
          <PasswordInput
            value={passphrase}
            autoComplete="new-password"
            placeholder="Something you will still have in a year"
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
          />
        </Field>
        {tooShort && <p class={s.fieldProblem}>{tooShort}</p>}

        <Field label="Type it again" hint="A typo here is a file nobody can ever open, including you.">
          <PasswordInput
            value={confirm}
            autoComplete="new-password"
            placeholder="Confirm the passphrase"
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
          />
        </Field>
        {mismatch && <p class={s.fieldProblem}>These two don’t match.</p>}

        <div class={s.exportToggle}>
          <Toggle
            checked={gatewayCanOpen}
            onChange={setGatewayCanOpen}
            label="Also let this gateway open the file without the passphrase"
            hint="Off is right for a file you are downloading. On, the backup can also be opened by anyone holding this server's MASTER_ENCRYPTION_KEY — useful for an unattended restore onto this same gateway, and one more way in for a stolen file."
          />
        </div>

        <div class={s.actions}>
          <Button variant="primary" onClick={run} disabled={busy || !ready}>
            {busy ? 'Writing the backup…' : 'Download backup'}
          </Button>
          {busy && (
            <span class={s.actionNote}>
              <KeyRound size={13} /> Reading every table and encrypting as it goes. Large gateways take a while.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
