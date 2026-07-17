import { useState } from 'preact/hooks';
import { UserPlus, Trash2, KeyRound } from 'lucide-preact';
import {
  POST, PATCH, DEL, getIdentity,
  type AdminUsersResponse, type AdminUserRow, type AdminInvitesResponse, type AdminInviteRow,
  type AdminRole, type RoleCatalogue,
} from '../../api';
import { useApi } from '../../hooks/useApi';
import { Card, Table, Badge, Button, Modal, Field, Input, Select, FormError, Spinner, CopyButton, type Column } from '../../ui';
import s from './admin.module.css';
import p from '../pages.module.css';

// Users and invites (Phase 7.13a).
//
// Reads are open to any admin — knowing who else can change the gateway you operate is not a
// privilege. Every write here is owner-only on the SERVER; this component hides what a non-owner
// cannot do, which is courtesy, not security.

const ROLE_TONE: Record<AdminRole, 'violet' | 'blue' | 'gray'> = {
  owner: 'violet', admin: 'blue', viewer: 'gray',
};

function RoleHelp({ roles }: { roles: RoleCatalogue }) {
  // The descriptions come from the server, which is also where the guards read the roles from — so
  // what an operator is told a role means cannot drift from what it actually permits.
  return (
    <div class={s.roleHelp}>
      {(['owner', 'admin', 'viewer'] as AdminRole[]).map((r) => (
        <div key={r} class={s.roleLine}>
          <span class={s.roleName}>{roles[r].label}</span> — {roles[r].description}
        </div>
      ))}
    </div>
  );
}

function InviteDialog({ roles, onClose, onDone }: {
  roles: RoleCatalogue; onClose: () => void; onDone: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole]   = useState<AdminRole>('viewer');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink]   = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await POST<{ token: string }>('/admin/invites', { email, role });
      setLink(`${window.location.origin}/invite?token=${r.token}`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the invite.');
    } finally {
      setBusy(false);
    }
  };

  // The link is shown once — only its hash is stored — so the dialog stops here rather than closing
  // itself and leaving the operator with nothing to send.
  if (link) {
    return (
      <Modal title="Invite created" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div class={s.once}>
          <div class={s.onceTitle}><KeyRound size={15} /> Send this link to {email}</div>
          <div class={s.linkBox}>{link}</div>
          <CopyButton value={link} label="Copy link" variant="secondary" />
          <p class={s.onceNote}>
            This is the only time the link is shown — the gateway stores only a fingerprint of it.
            It works once, expires in 7 days, and lets them choose their own password. Send it to
            them however you like; if it goes astray, just invite them again.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Invite someone"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !email}>
            {busy ? 'Creating…' : 'Create invite'}
          </Button>
        </>
      }
    >
      {error && <FormError>{error}</FormError>}
      <div class={s.forms}>
        <Field label="Email" hint="They choose their own name and password when they accept.">
          <Input
            type="email"
            value={email}
            autoFocus
            placeholder="them@company.com"
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value as AdminRole)}>
            <option value="viewer">{roles.viewer.label}</option>
            <option value="admin">{roles.admin.label}</option>
            <option value="owner">{roles.owner.label}</option>
          </Select>
          <RoleHelp roles={roles} />
        </Field>
      </div>
    </Modal>
  );
}

export function People() {
  const users = useApi<AdminUsersResponse>('/admin/users');
  const invites = useApi<AdminInvitesResponse>('/admin/invites');
  const me = getIdentity();
  const isOwner = me?.role === 'owner';

  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AdminUserRow | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      users.reload();
      invites.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    }
  };

  if (users.loading) return <Spinner />;
  if (users.error || !users.data) return <Card><FormError>{users.error ?? 'Could not load accounts.'}</FormError></Card>;

  const roles = users.data.roles;

  const userColumns: Column<AdminUserRow>[] = [
    {
      key: 'name', label: 'Person',
      render: (u) => (
        <div class={s.person}>
          <span class={s.personName}>
            {u.name}
            {u.id === me?.userId && <span class={s.you}>You</span>}
          </span>
          <span class={s.personEmail} title={u.email}>{u.email}</span>
        </div>
      ),
    },
    {
      key: 'role', label: 'Role',
      render: (u) => (
        // An owner may change anyone's role but their own — the server refuses that too, so this
        // is not the boundary, just the reason there is no dropdown on your own row.
        isOwner && u.id !== me?.userId
          ? (
            <Select
              class={s.roleSelect}
              value={u.role}
              aria-label={`Role for ${u.name}`}
              onChange={(e) => void act(() => PATCH(`/admin/users/${u.id}`, { role: (e.target as HTMLSelectElement).value }))}
            >
              <option value="viewer">{roles.viewer.label}</option>
              <option value="admin">{roles.admin.label}</option>
              <option value="owner">{roles.owner.label}</option>
            </Select>
          )
          : <Badge tone={ROLE_TONE[u.role]}>{roles[u.role].label}</Badge>
      ),
    },
    {
      key: 'source', label: 'Signs in with',
      render: (u) => (u.source === 'sso' ? <Badge tone="blue">Single sign-on</Badge> : <span>Password</span>),
    },
    {
      key: 'twoFactor', label: '2FA',
      render: (u) => (u.twoFactorEnabled ? <Badge tone="green" dot>On</Badge> : <Badge tone="gray">Off</Badge>),
    },
    {
      key: 'status', label: 'Status',
      render: (u) => (u.status === 'active' ? <Badge tone="green" dot>Active</Badge> : <Badge tone="yellow">Suspended</Badge>),
    },
    {
      key: 'lastLoginAt', label: 'Last signed in',
      render: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : <span class={s.selfNote}>Never</span>),
    },
    {
      key: 'actions', label: '', align: 'right',
      render: (u) => {
        if (!isOwner) return null;
        if (u.id === me?.userId) return <span class={s.selfNote}>Ask another owner</span>;
        return (
          <div class={s.rowActions}>
            <Button
              onClick={() => void act(() => PATCH(`/admin/users/${u.id}`, {
                status: u.status === 'active' ? 'suspended' : 'active',
              }))}
            >
              {u.status === 'active' ? 'Suspend' : 'Restore'}
            </Button>
            <Button variant="danger" onClick={() => setConfirmRemove(u)}>
              <Trash2 size={13} /> Remove
            </Button>
          </div>
        );
      },
    },
  ];

  const inviteColumns: Column<AdminInviteRow>[] = [
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', render: (i) => <Badge tone={ROLE_TONE[i.role]}>{roles[i.role].label}</Badge> },
    { key: 'invitedBy', label: 'Invited by', render: (i) => i.invitedBy ?? <span class={s.selfNote}>—</span> },
    {
      key: 'expiresAt', label: 'Expires',
      // An expired invite is shown, not hidden: an operator wondering why someone never got in
      // deserves to see that the link ran out rather than find an empty list.
      render: (i) => (i.expired
        ? <Badge tone="yellow">Expired</Badge>
        : new Date(i.expiresAt).toLocaleDateString()),
    },
    {
      key: 'actions', label: '', align: 'right',
      render: (i) => (isOwner
        ? <Button variant="danger" onClick={() => void act(() => DEL(`/admin/invites/${i.id}`))}>Revoke</Button>
        : null),
    },
  ];

  return (
    <>
      {error && <FormError>{error}</FormError>}

      <Card>
        <div class={s.head}>
          <div class={s.headText}>
            <span class={s.headTitle}>People</span>
            <span class={s.headSub}>
              Everyone who can sign in to this gateway. Every action they take is recorded against
              their name in the audit trail.
            </span>
          </div>
          {isOwner && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <UserPlus size={14} /> Invite
            </Button>
          )}
        </div>
        <Table columns={userColumns} rows={users.data.users} rowKey={(u) => u.id} empty="No accounts yet." />
      </Card>

      <div class={s.section}>
        <Card>
          <div class={s.head}>
            <div class={s.headText}>
              <span class={s.headTitle}>Pending invites</span>
              <span class={s.headSub}>
                Links that have been created but not used yet. Each works once and expires after
                {' '}{invites.data?.ttlDays ?? 7} days.
              </span>
            </div>
          </div>
          <Table
            columns={inviteColumns}
            rows={invites.data?.invites ?? []}
            rowKey={(i) => i.id}
            empty="No invites are waiting to be accepted."
          />
        </Card>
      </div>

      {inviting && (
        <InviteDialog roles={roles} onClose={() => setInviting(false)} onDone={() => invites.reload()} />
      )}

      {confirmRemove && (
        <Modal
          title={`Remove ${confirmRemove.name}?`}
          onClose={() => setConfirmRemove(null)}
          footer={
            <>
              <Button onClick={() => setConfirmRemove(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = confirmRemove;
                  setConfirmRemove(null);
                  void act(() => DEL(`/admin/users/${target.id}`));
                }}
              >
                Remove account
              </Button>
            </>
          }
        >
          <p class={p.setDesc}>
            <strong>{confirmRemove.email}</strong> will lose access immediately — any session they
            have open stops working on its next request, and every API token they created is revoked.
          </p>
          <p class={p.setDesc}>
            What they did stays in the audit trail under their name. That is deliberate: a record of
            who did what has to outlive the account.
          </p>
        </Modal>
      )}
    </>
  );
}
