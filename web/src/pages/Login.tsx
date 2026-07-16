import { useState } from 'preact/hooks';
import { LogIn } from 'lucide-preact';
import { login } from '../api';
import { useBranding } from '../hooks/useBranding';
import { Button, Field, Input, FormError } from '../ui';
import s from './login.module.css';

// The sign-in gate (Phase 7.9b). The redesigned dashboard shipped without one — the cutover surfaced
// that the old dashboard's login was never rebuilt — so the app was unreachable without a hand-set
// token. The gateway's auth (password → session token, TOTP, lockout) has existed since Phase 6; this
// is only its screen. On a correct password with 2FA enrolled the gateway asks for a code, so the code
// field appears on demand rather than always cluttering a first sign-in.

export function Login({ onAuthed }: { onAuthed: () => void }) {
  // Branding (P7.11) comes from the public `GET /branding`, so an operator's own name and mark greet
  // their team before anyone signs in. Unset → the product's own, exactly as before.
  const brand = useBranding();
  const [password, setPassword] = useState('');
  const [code, setCode]         = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [hint, setHint]         = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError(null);
    const r = await login(password, needCode ? code : undefined);
    setBusy(false);
    if (r.ok) { onAuthed(); return; }
    if (r.totpRequired) {
      // First correct password with 2FA on: reveal the code field instead of showing an error.
      setNeedCode(true);
      setHint('Enter the 6-digit code from your authenticator app, or a recovery code.');
      return;
    }
    setHint(null);
    setError(r.lockedOut && r.retryAfter
      ? `Too many attempts. Try again in ${r.retryAfter}s.`
      : (r.error ?? 'Invalid credentials.'));
  };

  return (
    <div class={s.wrap}>
      <form class={s.card} onSubmit={submit}>
        <div class={s.brand}>
          <img src={brand.logoDataUri || '/logo.svg'} width="34" height="34" alt="" />
          <div>
            <div class={s.title}>{brand.companyName || 'Alayra Nexus'}</div>
            <div class={s.sub}>Gateway administration</div>
          </div>
        </div>

        {error && <FormError>{error}</FormError>}
        {hint && !error && <p class={s.hint}>{hint}</p>}

        <Field label="Admin password">
          <Input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            placeholder="Your admin password"
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </Field>

        {needCode && (
          <Field label="Authenticator code" hint="6 digits, or a recovery code">
            <Input
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            />
          </Field>
        )}

        <Button variant="primary" type="submit" disabled={!password || busy}>
          <LogIn size={14} /> {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p class={s.note}>
        Your password is never stored — a sign-in exchanges it for a short-lived session token that
        lasts until you sign out or it expires.
      </p>
    </div>
  );
}
