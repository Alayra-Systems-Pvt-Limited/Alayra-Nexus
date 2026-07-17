import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { LifeBuoy, Check, Download } from 'lucide-preact';
import { recoverPassword } from '../../api';
import { Button, Field, Input, FormError, CopyButton } from '../../ui';
import { download } from '../../lib/download';
import { recoveryKeyFile } from './recoveryFile';
import s from '../login.module.css';

// A forgotten password (Phase 7.13a).
//
// No email is sent, and that is deliberate rather than a shortcut: email delivery is optional in this
// gateway and off by default, so a reset that could only arrive by email would be a flow that
// silently never works for most deployments. The recovery key issued when the account was created is
// the credential instead — 128 bits, single use, and it hands back a replacement.
//
// It restores the password ONLY. Someone with a confirmed authenticator still has to present a code
// at sign-in: recovering a password should not also disarm the defence that exists precisely for the
// case where the password is already known to someone else.

export function RecoverPassword({ brand, onDone }: { brand: ComponentChildren; onDone: () => void }) {
  const [email, setEmail]             = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await recoverPassword({ email, recoveryKey, newPassword });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'That email and recovery key do not match an active account.'); return; }
    setReplacement(r.recoveryKey ?? '');
  };

  if (replacement !== null) {
    return (
      <div class={s.wrap}>
        <div class={s.card}>
          {brand}
          <div class={s.done}>
            <Check size={18} />
            <span>Your password has been reset.</span>
          </div>

          <Field
            label="Your new recovery key"
            hint="The old one is spent. Save this replacement — it is shown once, and it is your way back if this happens again."
          >
            <div class={s.keyRow}>
              <code class={s.key}>{replacement}</code>
              <CopyButton value={replacement} label="Copy" variant="secondary" />
              <Button type="button" variant="secondary" onClick={() => download('nexus-recovery-key.txt', recoveryKeyFile(replacement))}>
                <Download size={14} /> Download
              </Button>
            </div>
          </Field>

          <Button variant="primary" onClick={onDone}>Back to sign in</Button>
        </div>
      </div>
    );
  }

  return (
    <div class={s.wrap}>
      <form class={s.card} onSubmit={submit}>
        {brand}

        <div class={s.done}>
          <LifeBuoy size={18} />
          <span>Use your recovery key</span>
        </div>

        <p class={s.hint}>
          The key you saved when your account was created. If you have a second factor, you will still
          need your authenticator to sign in afterwards.
        </p>

        {error && <FormError>{error}</FormError>}

        <Field label="Your email">
          <Input
            type="email"
            value={email}
            autoFocus
            autoComplete="username"
            placeholder="you@company.com"
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Recovery key">
          <Input
            value={recoveryKey}
            autoComplete="off"
            placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
            onInput={(e) => setRecoveryKey((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Choose a new password" hint="At least 12 characters.">
          <Input
            type="password"
            value={newPassword}
            autoComplete="new-password"
            placeholder="Your new password"
            onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Button variant="primary" type="submit" disabled={busy || !email || !recoveryKey || !newPassword}>
          {busy ? 'Resetting…' : 'Reset password'}
        </Button>

        <button type="button" class={s.link} onClick={onDone}>Back to sign in</button>
      </form>

      <p class={s.note}>
        Lost your recovery key as well? An owner can remove and re-invite you. If you are the only
        owner, the way back is a full reset of the gateway — which erases everything in it.
      </p>
    </div>
  );
}
