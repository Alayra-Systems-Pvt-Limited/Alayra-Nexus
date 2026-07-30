import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ShieldCheck, KeyRound, Download, ShieldQuestion, UserPlus, Building2, ArrowLeft, Archive, RefreshCw } from 'lucide-preact';
import { claimGateway, PUT } from '../../api';
import { Button, Field, Input, PasswordInput, PasswordStrength, FormError, CopyButton } from '../../ui';
import { download } from '../../lib/download';
import { recoveryKitFile } from './recoveryFile';
import { generatePassphrase, PASSPHRASE_BITS } from './passphrase';
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
/** Matches passphraseProblem() on the server; a shorter one would be accepted here and refused there. */
const MIN_PASSPHRASE = 12;

export function ClaimGateway({
  brand, carriesExistingTwoFactor, onAuthed,
}: {
  brand: ComponentChildren;
  carriesExistingTwoFactor: boolean;
  onAuthed: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
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

  // Step 4 (C6). `generated` is what decides whether the passphrase may be written into the kit:
  // one we made exists nowhere else in this person's life, one they chose probably does.
  const [generated, setGenerated] = useState(true);
  const [backupPassphrase, setBackupPassphrase] = useState(() => generatePassphrase());
  const [chosen, setChosen] = useState('');
  const [masterKey, setMasterKey] = useState('');
  const [pasteBack, setPasteBack] = useState('');
  /** Whether the kit has been downloaded, so step 2 can say where to find what it is asking for. */
  const [downloaded, setDownloaded] = useState(false);

  const passphrase = generated ? backupPassphrase : chosen;

  const mismatch  = confirm.length > 0 && confirm !== password;
  const step1Ok = masterPassword.length > 0;
  const step2Ok = name.trim().length > 0 && email.trim().length > 0
    && password.length >= MIN_PASSWORD && confirm === password;
  const step4Ok = passphrase.length >= MIN_PASSPHRASE;

  // The paste-back gate. A checkbox saying "I saved it" is a lie detector that does not work —
  // everybody ticks it. You cannot paste what you did not save.
  const savedProof = pasteBack.trim() === passphrase;

  const finish = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    // try/catch/finally so a thrown claim (network drop) surfaces an error and re-enables the button,
    // rather than leaving the wizard permanently stuck on "Creating your account…".
    try {
      const r = await claimGateway({ masterPassword, name, email, password, backupPassphrase: passphrase });
      if (!r.ok) { setError(r.error ?? 'Could not create your account.'); return; }
      setMasterKey(r.masterEncryptionKey ?? '');
      // The claim signed us in; name the workspace if one was given. Best-effort — a branding failure
      // must never strand a freshly-created owner outside their gateway.
      if (orgName.trim()) {
        try { await PUT('/admin/branding', { companyName: orgName.trim() }); } catch { /* non-fatal */ }
      }
      setCarried(!!r.twoFactorCarriedOver);
      setRecoveryKey(r.recoveryKey ?? '');
    } catch {
      setError('Could not create your account.');
    } finally {
      setBusy(false);
    }
  };

  if (recoveryKey !== null) {
    const kit = recoveryKitFile({
      organisation: orgName.trim(),
      gatewayUrl: window.location.origin,
      accountRecoveryKey: recoveryKey,
      masterEncryptionKey: masterKey,
      // Only ours goes in the file. See recoveryFile.ts for why a self-chosen one gets a blank line.
      backupPassphrase: generated ? passphrase : null,
    });

    return (
      <div class={s.wrap}>
        <div class={s.card}>
          {brand}
          <div class={s.done}>
            <ShieldCheck size={18} />
            <span>Your owner account is ready.</span>
          </div>

          <p class={s.hint}>
            One file holds everything needed to recover this gateway: your account recovery key, your
            master encryption key, and{' '}
            {generated ? 'your backup passphrase' : 'a blank line to write your backup passphrase on'}.
            Keep it somewhere safe and offline.
          </p>

          <Field label="Your account recovery key" hint="Gets you back in if you forget your password. Shown only once.">
            <div class={s.keyRow}>
              <code class={s.key}>{recoveryKey}</code>
              <CopyButton value={recoveryKey} label="Copy" variant="secondary" />
            </div>
          </Field>

          {generated && (
            <Field label="Your backup passphrase" hint="Opens your backups on a new machine. Without it a backup cannot be opened at all.">
              <div class={s.keyRow}>
                <code class={s.key}>{passphrase}</code>
                <CopyButton value={passphrase} label="Copy" variant="secondary" />
              </div>
            </Field>
          )}

          {/* Primary, and numbered. The first person through this screen read it as three things to
              consider rather than two things to do in order, and stalled — the button below is
              disabled until the passphrase is pasted back, with nothing saying that downloading is
              what makes pasting possible. Saying "1" and "2" out loud costs a line and removes the
              guesswork. */}
          <p class={s.hint}><strong>1.</strong> Download the kit — it contains everything above.</p>
          <Button
            type="button"
            variant="primary"
            onClick={() => { download('alayra-nexus-recovery-kit.txt', kit); setDownloaded(true); }}
          >
            <Download size={14} /> Download Recovery Kit
          </Button>

          <p class={s.hint}>
            <strong>2.</strong> Paste your backup passphrase below to confirm you have it.
            {downloaded && ' It is in the file you just downloaded, and on the Copy button above.'}
          </p>

          {/* The gate. Not a checkbox: you cannot paste what you did not save. */}
          <Field
            label="Confirm you saved it"
            hint="We ask because we cannot recover it for you. There is no reset link."
          >
            <Input
              value={pasteBack}
              autoComplete="off"
              spellcheck={false}
              placeholder={generated ? 'copper-lantern-drift-…' : 'Your backup passphrase'}
              onInput={(e) => setPasteBack((e.target as HTMLInputElement).value)}
            />
          </Field>
          {pasteBack.length > 0 && !savedProof && (
            <p class={s.confirmErr}>That does not match. Check the kit you just downloaded.</p>
          )}

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

          {/* The label names the ACTUAL gate. An earlier draft said "Download your kit to
              continue" while the button was in fact waiting on the paste-back — a instruction that
              does not unblock the thing it points at is worse than no instruction. */}
          <Button variant="primary" disabled={!savedProof} onClick={onAuthed}>
            {savedProof ? 'Continue to your gateway' : 'Confirm your passphrase to continue'}
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

        <div class={s.stepper} role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={4} aria-label={`Step ${step} of 4`}>
          {[1, 2, 3, 4].map((n) => (
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
                onKeyDown={(e) => { if (e.key === 'Enter') setStep(4); }} />
            </Field>

            <div class={s.stepActions}>
              <Button variant="ghost" onClick={() => setStep(2)}><ArrowLeft size={14} /> Back</Button>
              <Button variant="primary" onClick={() => setStep(4)}>Continue</Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div key="s4" class={s.step}>
            <div class={s.stepHead}>
              <div class={s.stepTitle}><Archive size={16} /> Protect your backups</div>
              <p class={s.hint}>
                This gateway will back itself up without anyone present. Your passphrase locks those
                backups to you — the server keeps only the half that can lock them, never the half
                that opens them. Even someone who steals the whole machine cannot read them.
              </p>
            </div>

            <div class={s.stepActions}>
              <Button
                type="button"
                variant={generated ? 'primary' : 'ghost'}
                onClick={() => setGenerated(true)}
              >
                Generate one for me
              </Button>
              <Button
                type="button"
                variant={generated ? 'ghost' : 'primary'}
                onClick={() => setGenerated(false)}
              >
                I’ll choose my own
              </Button>
            </div>

            {generated ? (
              <Field
                label="Your backup passphrase"
                hint={`${PASSPHRASE_BITS} bits of randomness. Because we generated it, it goes in your Recovery Kit — it exists nowhere else, so writing it down costs you nothing.`}
              >
                <div class={s.keyRow}>
                  <code class={s.key}>{backupPassphrase}</code>
                  {/* Copy belongs on every screen that shows a secret, not only the last one. It was
                      missing here, so the only way past this step was to read the passphrase off the
                      screen and retype it — for a value we generated precisely so nobody would. */}
                  <CopyButton value={backupPassphrase} label="Copy" variant="secondary" />
                  <Button type="button" variant="secondary" onClick={() => setBackupPassphrase(generatePassphrase())}>
                    <RefreshCw size={14} /> New one
                  </Button>
                </div>
              </Field>
            ) : (
              <Field
                label="Choose a backup passphrase"
                hint="At least 12 characters. This one will NOT be written into your Recovery Kit — people reuse passwords, and a file that leaked would expose everything else it unlocks too. The kit leaves a line for you to write it on."
              >
                <Input
                  value={chosen}
                  autoFocus
                  autoComplete="off"
                  spellcheck={false}
                  placeholder="Something you will still have in a year"
                  onInput={(e) => setChosen((e.target as HTMLInputElement).value)}
                />
              </Field>
            )}

            <p class={s.note}>
              We cannot recover this for you. There is no reset link — that is what makes a backup
              worth taking.
            </p>

            <div class={s.stepActions}>
              <Button variant="ghost" onClick={() => setStep(3)} disabled={busy}><ArrowLeft size={14} /> Back</Button>
              <Button variant="primary" disabled={busy || !step4Ok} onClick={finish}>
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
