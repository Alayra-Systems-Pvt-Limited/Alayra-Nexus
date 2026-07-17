import { useState } from 'preact/hooks';
import { ShieldCheck } from 'lucide-preact';
import { POST, ApiError, type AuthStatus } from '../../api';
import { Card, Button, Badge, Spinner, Field, Input, CopyField, QrCode, FormError } from '../../ui';
import { useApi } from '../../hooks/useApi';
import { RecoveryCodes } from './RecoveryCodes';
import s from '../pages.module.css';

// Second-factor management over the endpoints that have existed since Phase 6 (auth.routes.ts). The
// gateway does the security; this surfaces it honestly. The 2FA secret is offered as a copyable key
// and an otpauth:// URI (every authenticator accepts manual entry), so no QR library is pulled in.
//
// Every mutating call here is owner-only on the server, so a viewer session is met with a plain
// "read-only" message rather than a raw 403.

function humanDuration(secs: number): string {
  if (secs % 3600 === 0) { const h = secs / 3600; return `${h} hour${h === 1 ? '' : 's'}`; }
  if (secs % 60 === 0)   { const m = secs / 60;   return `${m} minute${m === 1 ? '' : 's'}`; }
  return `${secs} seconds`;
}

// Warn that recovery codes are running low once this few remain, so an operator regenerates before
// they can be locked out of their own second factor.
const LOW_RECOVERY_CODES_THRESHOLD = 3;

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return 'Your session is read-only (viewer). An owner credential is required for this.';
  }
  return err instanceof ApiError ? err.message : fallback;
}

export function SigninSecurity() {
  const { data, loading, error, reload } = useApi<AuthStatus>('/admin/auth/status');

  const [enrol, setEnrol]       = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [code, setCode]         = useState('');           // shared code field for the active action
  const [reveal, setReveal]     = useState<null | 'regen' | 'disable'>(null);
  const [showManual, setManual] = useState(false);   // "can't scan?" fallback to the typed key
  const [busy, setBusy]         = useState<string | null>(null);
  const [actionError, setError] = useState<string | null>(null);

  if (loading && !data) return <Card><div class={s.centered}><Spinner /> <span>Loading…</span></div></Card>;
  if (error || !data) {
    return (
      <Card>
        <div class={s.errBody}>
          <p>Couldn’t load your security status{error ? ` — ${error}` : ''}.</p>
          <Button size="sm" onClick={reload}>Retry</Button>
        </div>
      </Card>
    );
  }

  const reset = () => { setCode(''); setReveal(null); setError(null); };

  const beginEnrol = async () => {
    setBusy('enrol'); setError(null);
    try { setEnrol(await POST('/admin/auth/totp/enrol')); }
    catch (e) { setError(friendlyError(e, 'Could not start enrolment.')); }
    finally { setBusy(null); }
  };

  const confirmEnrol = async () => {
    setBusy('confirm'); setError(null);
    try {
      const { recoveryCodes } = await POST<{ recoveryCodes: string[] }>('/admin/auth/totp/confirm', { code: code.trim() });
      setRecovery(recoveryCodes); setEnrol(null); reset();
    } catch (e) { setError(friendlyError(e, 'That code was not accepted.')); }
    finally { setBusy(null); }
  };

  const regenerate = async () => {
    setBusy('regen'); setError(null);
    try {
      const { recoveryCodes } = await POST<{ recoveryCodes: string[] }>('/admin/auth/recovery-codes', { code: code.trim() });
      setRecovery(recoveryCodes); reset();
    } catch (e) { setError(friendlyError(e, 'That code was not accepted.')); }
    finally { setBusy(null); }
  };

  const disable = async () => {
    setBusy('disable'); setError(null);
    try { await POST('/admin/auth/totp/disable', { code: code.trim() }); reset(); reload(); }
    catch (e) { setError(friendlyError(e, 'That code was not accepted.')); }
    finally { setBusy(null); }
  };

  // The one-time recovery-code reveal takes over the panel until acknowledged.
  if (recovery) {
    return (
      <Card heading="Recovery codes">
        <RecoveryCodes codes={recovery} onDone={() => { setRecovery(null); reload(); }} />
      </Card>
    );
  }

  const low = data.twoFactorEnabled && data.recoveryCodesRemaining <= LOW_RECOVERY_CODES_THRESHOLD;

  return (
    <>
      <Card heading="Two-factor authentication">
        {data.twoFactorEnabled ? (
          <>
            <div class={s.secStatus}>
              <Badge tone="green"><ShieldCheck size={12} /> On</Badge>
              <span>An authenticator code is required at sign-in, on top of the password.</span>
            </div>
            <p class={low ? s.fieldWarn : s.setHint}>
              {data.recoveryCodesRemaining} recovery {data.recoveryCodesRemaining === 1 ? 'code' : 'codes'} remaining
              {low ? ' — running low. Regenerate to get a fresh set of ten.' : '.'}
            </p>

            {actionError && <FormError>{actionError}</FormError>}

            <div class={s.secActions}>
              <Button size="sm" onClick={() => { reset(); setReveal(reveal === 'regen' ? null : 'regen'); }}>Regenerate recovery codes</Button>
              <Button size="sm" variant="danger" onClick={() => { reset(); setReveal(reveal === 'disable' ? null : 'disable'); }}>Turn off two-factor</Button>
            </div>

            {reveal && (
              <div class={s.secConfirm}>
                <Field
                  label={reveal === 'regen' ? 'Confirm with an authenticator code' : 'Confirm with an authenticator or recovery code'}
                  hint={reveal === 'regen' ? '6 digits' : '6 digits, or a recovery code'}
                >
                  <Input value={code} placeholder="123456" onInput={(e) => setCode((e.target as HTMLInputElement).value)} autofocus />
                </Field>
                {reveal === 'regen'
                  ? <Button size="sm" variant="primary" onClick={regenerate} disabled={!code.trim() || busy === 'regen'}>{busy === 'regen' ? 'Working…' : 'Regenerate'}</Button>
                  : <Button size="sm" variant="danger"  onClick={disable}    disabled={!code.trim() || busy === 'disable'}>{busy === 'disable' ? 'Working…' : 'Turn off two-factor'}</Button>}
              </div>
            )}
          </>
        ) : (
          <>
            <div class={s.secStatus}>
              <Badge tone="yellow">Off</Badge>
              <span>Your password alone signs you in. Add an authenticator to require a code as well.</span>
            </div>
            {data.enrolmentPending && !enrol && (
              <p class={s.setHint}>An earlier setup was started but never confirmed. Starting again replaces it.</p>
            )}

            {actionError && <FormError>{actionError}</FormError>}

            {!enrol && (
              <Button variant="primary" size="sm" onClick={beginEnrol} disabled={busy === 'enrol'}>
                {busy === 'enrol' ? 'Starting…' : 'Set up two-factor'}
              </Button>
            )}

            {enrol && (
              <div class={s.secEnrol}>
                <p class={s.setHint}>
                  Scan this with your authenticator app — Google Authenticator, 1Password, Authy, any of
                  them — then enter the six-digit code it shows to confirm.
                </p>

                <figure class={s.secQr}>
                  <QrCode value={enrol.otpauthUri} label="Two-factor setup QR code" />
                  <figcaption>Alayra Nexus · two-factor</figcaption>
                </figure>

                <button type="button" class={s.secManualToggle} onClick={() => setManual((m) => !m)}>
                  {showManual ? 'Hide manual setup' : 'Can’t scan? Enter the key by hand'}
                </button>
                {showManual && (
                  <div class={s.secManual}>
                    <p class={s.secQrHint}>Most apps also accept a typed key or the full setup link.</p>
                    <CopyField label="Setup key" value={enrol.secret} />
                    <CopyField label="otpauth" value={enrol.otpauthUri} />
                  </div>
                )}

                <Field label="Code from your app" hint="6 digits">
                  <Input value={code} placeholder="123456" onInput={(e) => setCode((e.target as HTMLInputElement).value)} autofocus />
                </Field>
                <div class={s.secActions}>
                  <Button size="sm" variant="ghost" onClick={() => { setEnrol(null); setManual(false); reset(); }} disabled={busy === 'confirm'}>Cancel</Button>
                  <Button size="sm" variant="primary" onClick={confirmEnrol} disabled={!code.trim() || busy === 'confirm'}>{busy === 'confirm' ? 'Confirming…' : 'Confirm & enable'}</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card heading="Sign-in policy" class={s.section}>
        <ul class={s.factList}>
          <li>A dashboard session lasts <b>{humanDuration(data.sessionTtlSeconds)}</b> before you sign in again.</li>
          <li><b>{data.maxLoginAttempts}</b> failed attempts locks sign-in from that source for <b>{humanDuration(data.lockoutSeconds)}</b>.</li>
        </ul>
        <p class={s.setHint}>These are set where the gateway is deployed and are shown here for reference.</p>
      </Card>
    </>
  );
}
