import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ShieldCheck, KeyRound, Download, ShieldQuestion, UserPlus, Building2, ArrowLeft } from 'lucide-preact';
import { claimGateway, PUT } from '../../api';
import { Button, Field, Input, PasswordInput, PasswordStrength, FormError, CopyButton } from '../../ui';
import { download } from '../../lib/download';
import { recoveryKeyFile } from './recoveryFile';
import s from '../login.module.css';

// First run (Phase 7.13a; restyled as a stepped wizard in 7.16b): the screen that turns a gateway
// with no accounts into one with an owner.
//
// It asks for the ADMIN_PASSWORD from the server's .env, and that is the whole security model here:
// it lives in the deployer's environment and nowhere else, so it is proof that you are the person who
// installed this gateway — not merely the first person to find the port.
//
// The wizard walks three steps — prove ownership, create the account, name the workspace — but the
// claim itself is one call at the end. The workspace name (step 3, optional) is saved to branding
// after the claim, using the session token the claim returns, so the dashboard is white-labelled
// from first paint. Failing to save it never blocks onboarding.

const MIN_PASSWORD = 12;

export function ClaimGateway({
  brand, carriesExistingTwoFactor, onAuthed,
}: {
  brand: ComponentChildren;
  carriesExistingTwoFactor: boolean;
  onAuthed: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [masterPassword, setMasterPassword] = useState('');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [orgName, setOrgName]   = useState('');
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Shown after the account exists but before we let them into the dashboard. This is the only time
  // the recovery key is ever visible, so the flow stops here on purpose rather than sliding past it.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [carried, setCarried] = useState(false);

  const mismatch  = confirm.length > 0 && confirm !== password;
  const step1Ok = masterPassword.length > 0;
  const step2Ok = name.trim().length > 0 && email.trim().length > 0
    && password.length >= MIN_PASSWORD && confirm === password;

  const finish = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await claimGateway({ masterPassword, name, email, password });
    if (!r.ok) { setBusy(false); setError(r.error ?? 'Could not create your account.'); return; }
    // The claim signed us in; name the workspace if one was given. Best-effort — a branding failure
    // must never strand a freshly-created owner outside their gateway.
    if (orgName.trim()) {
      try { await PUT('/admin/branding', { companyName: orgName.trim() }); } catch { /* non-fatal */ }
    }
    setBusy(false);
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
      <div class={s.card}>
        {brand}

        <div class={s.done}>
          <KeyRound size={18} />
          <span>Set up your gateway</span>
        </div>

        <div class={s.stepper} role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={3} aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((n) => (
            <span key={n} class={n === step ? s.stepDotActive : n < step ? s.stepDotDone : s.stepDot} />
          ))}
        </div>

        {error && <FormError>{error}</FormError>}

        {step === 1 && (
          <div key="s1" class={s.step}>
            <div class={s.stepHead}>
              <div class={s.stepTitle}><ShieldQuestion size={16} /> Prove you installed this</div>
              <p class={s.hint}>
                Enter the <code>ADMIN_PASSWORD</code> from your server’s environment. It lives only in
                your deployment, so it proves you are the installer — not the first stranger to find
                the port.
              </p>
            </div>

            <Field label="Administrator password" hint="From your .env">
              <PasswordInput
                value={masterPassword}
                autoFocus
                autoComplete="off"
                placeholder="ADMIN_PASSWORD"
                onInput={(e) => setMasterPassword((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && step1Ok) setStep(2); }}
              />
            </Field>

            <Button variant="primary" disabled={!step1Ok} onClick={() => setStep(2)}>Continue</Button>
          </div>
        )}

        {step === 2 && (
          <div key="s2" class={s.step}>
            <div class={s.stepHead}>
              <div class={s.stepTitle}><UserPlus size={16} /> Create your account</div>
              <p class={s.hint}>
                You are the owner. After this, everyone signs in as themselves and the audit trail
                records who did what by name.
              </p>
            </div>

            <Field label="Your name">
              <Input value={name} autoFocus autoComplete="name" placeholder="Ada Lovelace"
                onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </Field>

            <Field label="Your email" hint="This is how you will sign in.">
              <Input type="email" value={email} autoComplete="username" placeholder="you@company.com"
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
            </Field>

            <Field label="Choose a password" hint="At least 12 characters. A long phrase beats a short, complicated one.">
              <PasswordInput value={password} autoComplete="new-password" placeholder="Your new password"
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
            </Field>
            <PasswordStrength value={password} />

            <Field label="Confirm password">
              <PasswordInput value={confirm} autoComplete="new-password" placeholder="Type it again"
                onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
                onBlur={() => setConfirmTouched(true)} />
            </Field>
            {mismatch && confirmTouched && <p class={s.confirmErr}>Passwords don’t match.</p>}

            <div class={s.stepActions}>
              <Button variant="ghost" onClick={() => setStep(1)}><ArrowLeft size={14} /> Back</Button>
              <Button variant="primary" disabled={!step2Ok} onClick={() => setStep(3)}>Continue</Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div key="s3" class={s.step}>
            <div class={s.stepHead}>
              <div class={s.stepTitle}><Building2 size={16} /> Name your workspace</div>
              <p class={s.hint}>
                Optional. Set your organization’s name and the whole console carries it instead of
                “Alayra Nexus” — you can change it, and add a logo, later in Settings.
              </p>
            </div>

            <Field label="Organization name" hint="optional">
              <Input value={orgName} autoFocus placeholder="Acme Corp"
                onInput={(e) => setOrgName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void finish(); }} />
            </Field>

            <div class={s.stepActions}>
              <Button variant="ghost" onClick={() => setStep(2)} disabled={busy}><ArrowLeft size={14} /> Back</Button>
              <Button variant="primary" disabled={busy} onClick={finish}>
                {busy ? 'Creating your account…' : 'Create owner account'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {carriesExistingTwoFactor && (
        <p class={s.note}>
          Two-factor authentication is already switched on here. Your authenticator app and any unused
          recovery codes will carry over to your new account — you will not have to set them up again.
        </p>
      )}
    </div>
  );
}
