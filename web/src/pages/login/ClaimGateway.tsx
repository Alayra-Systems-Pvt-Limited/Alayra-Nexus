import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ShieldCheck, KeyRound, Download } from 'lucide-preact';
import { claimGateway } from '../../api';
import { Button, Field, Input, FormError, CopyButton } from '../../ui';
import { download } from '../../lib/download';
import { recoveryKeyFile } from './recoveryFile';
import s from '../login.module.css';

// First run (Phase 7.13a): the screen that turns a gateway with no accounts into one with an owner.
//
// It asks for the ADMIN_PASSWORD from the server's .env, and that is the whole security model here:
// it lives in the deployer's environment and nowhere else, so it is proof that you are the person who
// installed this gateway — not merely the first person to find the port. Without it, whoever reached
// an unclaimed gateway first would own it.
//
// An existing deployment sees this screen once, after upgrading, and nothing about it is a
// disruption: the master password kept working right up to this moment, and their authenticator
// carries over.

export function ClaimGateway({
  brand, carriesExistingTwoFactor, onAuthed,
}: {
  brand: ComponentChildren;
  carriesExistingTwoFactor: boolean;
  onAuthed: () => void;
}) {
  const [masterPassword, setMasterPassword] = useState('');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Shown after the account exists but before we let them into the dashboard. This is the only time
  // the recovery key is ever visible, so the flow stops here on purpose rather than sliding past it.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [carried, setCarried] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await claimGateway({ masterPassword, name, email, password });
    setBusy(false);
    if (!r.ok) { setError(r.error ?? 'Could not create your account.'); return; }
    setCarried(!!r.twoFactorCarriedOver);
    setRecoveryKey(r.recoveryKey ?? '');
  };

  if (recoveryKey !== null) {
    return (
      <div class={s.wrap}>
        <div class={s.card}>
          {brand}
          <div class={s.done}>
            <ShieldCheck size={18} />
            <span>Your owner account is ready.</span>
          </div>

          <Field
            label="Your recovery key"
            hint="Save this somewhere safe. It is the only way back in if you forget your password — and this is the only time it is shown."
          >
            <div class={s.keyRow}>
              <code class={s.key}>{recoveryKey}</code>
              <CopyButton value={recoveryKey} label="Copy" variant="secondary" />
              <Button type="button" variant="secondary" onClick={() => download('nexus-recovery-key.txt', recoveryKeyFile(recoveryKey))}>
                <Download size={14} /> Download
              </Button>
            </div>
          </Field>

          {carried && (
            <p class={s.hint}>
              Your existing authenticator app still works — its second factor and any unused recovery
              codes now belong to this account. Nothing to set up again.
            </p>
          )}

          <p class={s.note}>
            From now on you sign in with your email and password. The administrator password in your
            server’s environment no longer signs anyone in — it only sets up this gateway and, if you
            ever need it, resets it.
          </p>

          <Button variant="primary" onClick={onAuthed}>
            I’ve saved my recovery key — continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class={s.wrap}>
      <form class={s.card} onSubmit={submit}>
        {brand}

        <div class={s.done}>
          <KeyRound size={18} />
          <span>Set up your gateway</span>
        </div>

        <p class={s.hint}>
          Nobody administers this gateway yet. Create the owner account — after this, everyone signs
          in as themselves, and the audit trail records who did what by name.
        </p>

        {error && <FormError>{error}</FormError>}

        <Field
          label="Administrator password"
          hint="The ADMIN_PASSWORD from your server’s environment. It proves you installed this gateway."
        >
          <Input
            type="password"
            value={masterPassword}
            autoFocus
            autoComplete="off"
            placeholder="From your .env"
            onInput={(e) => setMasterPassword((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Your name">
          <Input
            value={name}
            autoComplete="name"
            placeholder="Ada Lovelace"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Your email" hint="This is how you will sign in.">
          <Input
            type="email"
            value={email}
            autoComplete="username"
            placeholder="you@company.com"
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Choose a password" hint="At least 12 characters. A long phrase beats a short, complicated one.">
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            placeholder="Your new password"
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Button
          variant="primary"
          type="submit"
          disabled={busy || !masterPassword || !name || !email || !password}
        >
          {busy ? 'Creating your account…' : 'Create owner account'}
        </Button>
      </form>

      {carriesExistingTwoFactor && (
        <p class={s.note}>
          Two-factor authentication is already switched on here. Your authenticator app and any unused
          recovery codes will carry over to your new account — you will not have to set them up again.
        </p>
      )}
    </div>
  );
}
