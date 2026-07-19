import { useState, useEffect } from 'preact/hooks';
import { LogIn } from 'lucide-preact';
import { login, fetchClaimStatus } from '../api';
import { useBranding } from '../hooks/useBranding';
import { Button, Field, Input, PasswordInput, FormError } from '../ui';
import { ClaimGateway } from './login/ClaimGateway';
import { RecoverPassword } from './login/RecoverPassword';
import s from './login.module.css';

// The sign-in gate (Phase 7.9b). The redesigned dashboard shipped without one — the cutover surfaced
// that the old dashboard's login was never rebuilt — so the app was unreachable without a hand-set
// token. The gateway's auth (password → session token, TOTP, lockout) has existed since Phase 6; this
// is only its screen. On a correct password with 2FA enrolled the gateway asks for a code, so the code
// field appears on demand rather than always cluttering a first sign-in.
//
// Phase 7.13a: sign-in is now an ACCOUNT — email and password. The screen has three states, chosen by
// asking the gateway whether anyone has claimed it yet:
//
//   unclaimed → the setup screen: prove you installed this (the server's ADMIN_PASSWORD), then
//               create the first owner. Also what an existing deployment sees after upgrading.
//   claimed   → email + password, and a "forgot your password" path that spends a recovery key.
//
// The status is fetched rather than assumed. A gateway we cannot reach is treated as CLAIMED, because
// showing a stranger the setup screen because a fetch failed would be the worst way to be wrong.

type Screen = 'loading' | 'claim' | 'signin' | 'recover';

export function Login({ onAuthed }: { onAuthed: () => void }) {
  // Branding (P7.11) comes from the public `GET /branding`, so an operator's own name and mark greet
  // their team before anyone signs in. Unset → the product's own, exactly as before.
  const brand = useBranding();
  const [screen, setScreen] = useState<Screen>('loading');
  const [carriesTwoFactor, setCarriesTwoFactor] = useState(false);

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode]         = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [hint, setHint]         = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchClaimStatus().then((st) => {
      if (!live) return;
      setCarriesTwoFactor(st.carriesExistingTwoFactor);
      setScreen(st.unclaimed ? 'claim' : 'signin');
    });
    return () => { live = false; };
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError(null);
    const r = await login(password, needCode ? code : undefined, email);
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

  const Brand = (
    <div class={s.brand}>
      <img src={brand.logoDataUri || '/logo.svg'} width="34" height="34" alt="" />
      <div>
        <div class={s.title}>{brand.companyName || 'Alayra Nexus'}</div>
        <div class={s.sub}>Gateway administration</div>
      </div>
    </div>
  );

  // Nothing at all until we know which screen is the right one. A flash of "sign in" on a gateway
  // that actually needs setting up is a confusing first impression of the product.
  if (screen === 'loading') return <div class={s.wrap} />;

  if (screen === 'claim') {
    return (
      <ClaimGateway brand={Brand} carriesExistingTwoFactor={carriesTwoFactor} onAuthed={onAuthed} />
    );
  }

  if (screen === 'recover') {
    return <RecoverPassword brand={Brand} onDone={() => setScreen('signin')} />;
  }

  return (
    <div class={s.wrap}>
      <form class={s.card} onSubmit={submit}>
        {Brand}

        {error && <FormError>{error}</FormError>}
        {hint && !error && <p class={s.hint}>{hint}</p>}

        <Field label="Email">
          <Input
            type="email"
            value={email}
            autoFocus
            autoComplete="username"
            placeholder="you@company.com"
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Password">
          <PasswordInput
            value={password}
            autoComplete="current-password"
            placeholder="Your password"
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

        <button type="button" class={s.link} onClick={() => setScreen('recover')}>
          Forgot your password?
        </button>
      </form>

      <p class={s.note}>
        Your password is never stored — a sign-in exchanges it for a short-lived session token that
        lasts until you sign out or it expires.
      </p>
    </div>
  );
}
