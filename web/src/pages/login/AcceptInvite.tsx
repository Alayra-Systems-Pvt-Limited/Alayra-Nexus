import { useState, useEffect } from 'preact/hooks';
import { UserCheck, Download } from 'lucide-preact';
import { login, type AdminRole, type RoleCatalogue } from '../../api';
import { useBranding } from '../../hooks/useBranding';
import { Button, Field, Input, FormError, CopyButton } from '../../ui';
import { download } from '../../lib/download';
import { recoveryKeyFile } from './recoveryFile';
import s from '../login.module.css';

// Accepting an invite (Phase 7.13a). Reached at /invite?token=… — before the invitee has an account,
// so it lives outside the auth gate and outside `api()` (there is no session to lose, and a failure
// here must not look like a logout).
//
// The invitee chooses their name and password. They do NOT get to send their email or their role:
// both come off the invite the owner created, so accepting cannot make you someone else, or
// something more. The owner never learns the password, so the account is not born already
// compromised by the person who created it.

interface InviteInfo { email: string; role: AdminRole }

export function AcceptInvite({ onAuthed }: { onAuthed: () => void }) {
  const brand = useBranding();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [roles, setRoles]   = useState<RoleCatalogue | null>(null);
  const [checking, setChecking] = useState(true);
  const [name, setName]         = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/admin/invites/accept?token=${encodeURIComponent(token)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { invite: InviteInfo; roles: RoleCatalogue }) : null))
      .catch(() => null)
      .then((data) => {
        if (!live) return;
        setInvite(data?.invite ?? null);
        setRoles(data?.roles ?? null);
        setChecking(false);
      });
    return () => { live = false; };
  }, [token]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/admin/invites/accept', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, name, password }),
      });
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { setError(String(b.error ?? 'Could not create your account.')); return; }
      setRecoveryKey(String(b.recoveryKey ?? ''));
    } catch {
      setError('Could not reach the gateway.');
    } finally {
      setBusy(false);
    }
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

  if (checking) return <div class={s.wrap} />;

  if (!invite) {
    return (
      <div class={s.wrap}>
        <div class={s.card}>
          {Brand}
          <FormError>That invite link is not valid, has already been used, or has expired.</FormError>
          <p class={s.hint}>Ask an owner of this gateway to send you a new one.</p>
          <Button onClick={() => { window.location.href = '/'; }}>Go to sign in</Button>
        </div>
      </div>
    );
  }

  // The account exists now, but the recovery key is shown exactly once — so the flow stops here
  // rather than sliding straight into the dashboard past the one thing they must keep.
  if (recoveryKey !== null) {
    return (
      <div class={s.wrap}>
        <div class={s.card}>
          {Brand}
          <div class={s.done}><UserCheck size={18} /> <span>Welcome. Your account is ready.</span></div>

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

          <Button
            variant="primary"
            onClick={async () => {
              // Sign them straight in with what they just chose. Making someone retype a password
              // from ten seconds ago is ceremony, not security.
              const r = await login(password, undefined, invite.email);
              if (r.ok) { window.history.replaceState({}, '', '/'); onAuthed(); }
              else window.location.href = '/';
            }}
          >
            I’ve saved my recovery key — continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class={s.wrap}>
      <form class={s.card} onSubmit={submit}>
        {Brand}

        <div class={s.done}><UserCheck size={18} /> <span>You’ve been invited</span></div>
        <p class={s.hint}>
          Set up your account for <strong>{invite.email}</strong>. You will have{' '}
          {roles?.[invite.role].label.toLowerCase() ?? invite.role} access
          {roles ? ` — ${roles[invite.role].description.toLowerCase()}` : ''}
        </p>

        {error && <FormError>{error}</FormError>}

        <Field label="Your name">
          <Input
            value={name}
            autoFocus
            autoComplete="name"
            placeholder="Ada Lovelace"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Choose a password" hint="At least 12 characters. Nobody else ever sees it — not even the person who invited you.">
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            placeholder="Your new password"
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Button variant="primary" type="submit" disabled={busy || !name || !password}>
          {busy ? 'Creating your account…' : 'Create account'}
        </Button>
      </form>
    </div>
  );
}
