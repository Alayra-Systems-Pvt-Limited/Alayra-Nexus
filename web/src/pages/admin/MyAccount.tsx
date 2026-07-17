import { useState } from 'preact/hooks';
import { ShieldAlert } from 'lucide-preact';
import { POST, type MeResponse } from '../../api';
import { useApi } from '../../hooks/useApi';
import { Card, Button, Badge, Field, Input, FormError, Spinner, CopyButton } from '../../ui';
import { Sessions } from './Sessions';
import s from './admin.module.css';
import p from '../pages.module.css';

// Your own account (Phase 7.13a). Everything here acts on the caller and nothing else: there is no
// user id in any of these requests for someone to swap for somebody else's.
//
// Note what an owner CANNOT do, here or anywhere: set another person's password. An owner who could
// would be able to sign in as them and act under their name, which would quietly undo the attribution
// this whole phase exists to create. To get someone back in, an owner removes and re-invites them.

export function MyAccount() {
  const me = useApi<MeResponse>('/admin/me');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);

  if (me.loading) return <Spinner />;
  if (me.error || !me.data) return <Card><FormError>{me.error ?? 'Could not load your account.'}</FormError></Card>;

  const account = me.data.account;

  // A session minted from an admin API token has a role but no person behind it. Say so plainly
  // rather than render a profile form that would fail on submit.
  if (!account) {
    return (
      <Card>
        <div class={s.head}>
          <div class={s.headText}>
            <span class={s.headTitle}>No account behind this session</span>
            <span class={s.headSub}>
              You are signed in with an admin API token, which is a credential rather than a person.
              It has {me.data.role} access, but there is no profile, password, or second factor to
              manage here. Sign in with your email and password to reach your account.
            </span>
          </div>
        </div>
      </Card>
    );
  }

  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await POST('/admin/me/password', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  const regenerateKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true); setError(null);
    try {
      const r = await POST<{ recoveryKey: string }>('/admin/me/recovery-key');
      setNewKey(r.recoveryKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue a new recovery key.');
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <>
      <Card>
        <div class={s.head}>
          <div class={s.headText}>
            <span class={s.headTitle}>{account.name}</span>
            <span class={s.headSub}>{account.email}</span>
          </div>
          <Badge tone={account.role === 'owner' ? 'violet' : account.role === 'admin' ? 'blue' : 'gray'}>
            {account.role === 'owner' ? 'Owner' : account.role === 'admin' ? 'Admin' : 'Viewer'}
          </Badge>
        </div>
        <p class={p.setDesc}>
          Your two-factor authentication and recovery codes live in{' '}
          <a href="/security">Security → Sign-in</a>. They are yours now, not the gateway’s — each
          person holds their own.
        </p>
      </Card>

      {account.source === 'sso' ? (
        <div class={s.section}>
          <Card>
            <div class={s.head}>
              <div class={s.headText}>
                <span class={s.headTitle}>Password</span>
                <span class={s.headSub}>
                  You sign in through your identity provider, so this account has no password here.
                  Change it where your organisation manages it.
                </span>
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <>
          <div class={s.section}>
            <Card>
              <div class={s.head}>
                <div class={s.headText}>
                  <span class={s.headTitle}>Change your password</span>
                  <span class={s.headSub}>
                    Your current password is required — knowing it is what proves it is you at the
                    keyboard, and not a session someone found unlocked.
                  </span>
                </div>
              </div>

              {error && <FormError>{error}</FormError>}
              {saved && <p class={s.headSub}>Password changed.</p>}

              <form class={s.forms} onSubmit={changePassword}>
                <Field label="Current password">
                  <Input
                    type="password"
                    value={current}
                    autoComplete="current-password"
                    onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
                  />
                </Field>
                <Field label="New password" hint="At least 12 characters. A long phrase beats a short, complicated one.">
                  <Input
                    type="password"
                    value={next}
                    autoComplete="new-password"
                    onInput={(e) => setNext((e.target as HTMLInputElement).value)}
                  />
                </Field>
                <div>
                  <Button variant="primary" type="submit" disabled={busy || !current || !next}>
                    {busy ? 'Changing…' : 'Change password'}
                  </Button>
                </div>
              </form>
            </Card>
          </div>

          <div class={s.section}>
            <Card>
              <div class={s.head}>
                <div class={s.headText}>
                  <span class={s.headTitle}>Recovery key</span>
                  <span class={s.headSub}>
                    Resets your password if you forget it — different from your recovery codes, which
                    stand in for a lost authenticator. Issuing a new one retires the old immediately.
                  </span>
                </div>
                <Button onClick={regenerateKey} disabled={keyBusy}>
                  {keyBusy ? 'Issuing…' : 'Issue a new key'}
                </Button>
              </div>

              {newKey && (
                <div class={s.once}>
                  <div class={s.onceTitle}><ShieldAlert size={15} /> Save this now — it is shown once</div>
                  <div class={s.linkBox}>{newKey}</div>
                  <CopyButton value={newKey} label="Copy" variant="secondary" />
                  <p class={s.onceNote}>
                    The gateway keeps only a fingerprint of this key, so it cannot show it to you
                    again — and a stolen database cannot yield a usable one either.
                  </p>
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      <Sessions />
    </>
  );
}
