import { useState } from 'preact/hooks';
import { KeyRound, Shuffle, Trash2 } from 'lucide-preact';
import { GET, POST, PATCH, DEL, ApiError, type TeamKeyRow, type TeamRow } from '../../api';
import { Card, Button, Badge, Spinner, Table, Field, Input, Select, CopyField, CopyButton, FormError, Modal, type Column } from '../../ui';
import { useApi } from '../../hooks/useApi';
import { relativeTime } from '../../lib/format';
import { canWrite } from '../../lib/access';
import s from '../pages.module.css';

// Scoped access keys — what a team's members actually present to the gateway. Each key may be assigned
// to a team (so its traffic counts against that team's budget and routing tier) or left unassigned.
// The plaintext key is returned once at creation and re-revealable on demand for copy, mirroring the
// server: the key is stored encrypted, not hashed-only, precisely so an operator can hand it out again.

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return 'Your session is read-only (viewer). An owner credential is required to manage keys.';
  }
  return err instanceof ApiError ? err.message : fallback;
}

export function TeamKeys() {
  const { data, loading, error, reload } = useApi<{ keys: TeamKeyRow[] }>('/admin/team-keys');
  const teamsApi = useApi<{ teams: TeamRow[] }>('/admin/teams');
  const teams = teamsApi.data?.teams ?? [];

  const [name, setName]         = useState('');
  const [teamId, setTeamId]     = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh]       = useState<{ name: string; key: string } | null>(null);
  const [formError, setFormErr] = useState<string | null>(null);

  const [reassign, setReassign] = useState<TeamKeyRow | null>(null);
  const [reassignTo, setReTo]   = useState('');
  const [reBusy, setReBusy]     = useState(false);

  const [revoking, setRevoking] = useState<TeamKeyRow | null>(null);
  const [revBusy, setRevBusy]   = useState(false);

  // Global view of every key across teams, filterable so a busy deployment stays navigable: by team
  // ('' = all, 'none' = unassigned) and a free-text match on name or masked key.
  const [filterTeam, setFilterTeam] = useState('');
  const [search, setSearch]         = useState('');

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true); setFormErr(null); setFresh(null);
    try {
      const { key } = await POST<{ key: { name: string; plainKey: string } }>('/admin/team-keys', { name: name.trim(), teamId: teamId || null });
      setFresh({ name: key.name, key: key.plainKey });
      setName(''); setTeamId('');
      reload();
    } catch (e) { setFormErr(friendlyError(e, 'Could not create the key.')); }
    finally { setCreating(false); }
  };

  // Resolve the LIVE key at click time — CopyButton handles the clipboard write and its animated
  // confirmation, so a reveal-then-copy no longer looks like nothing happened.
  const revealKey = async (row: TeamKeyRow): Promise<string> => {
    setFormErr(null);
    const { key } = await GET<{ key: string }>(`/admin/team-keys/${row.id}/reveal`);
    return key;
  };

  const doReassign = async () => {
    if (!reassign || reBusy) return;
    setReBusy(true); setFormErr(null);
    try { await PATCH(`/admin/team-keys/${reassign.id}`, { teamId: reassignTo || null }); setReassign(null); reload(); }
    catch (e) { setFormErr(friendlyError(e, 'Could not reassign the key.')); setReassign(null); }
    finally { setReBusy(false); }
  };

  const revoke = async () => {
    if (!revoking || revBusy) return;
    setRevBusy(true); setFormErr(null);
    try { await DEL(`/admin/team-keys/${revoking.id}`); setRevoking(null); reload(); }
    catch (e) { setFormErr(friendlyError(e, 'Could not revoke the key.')); setRevoking(null); }
    finally { setRevBusy(false); }
  };

  const cols: Column<TeamKeyRow>[] = [
    { key: 'name', label: 'Name', render: (k) => <span class={s.tokenName}>{k.name}</span> },
    { key: 'maskedKey', label: 'Key', render: (k) => <code class={s.tokenMask}>{k.maskedKey}</code> },
    { key: 'team', label: 'Team', render: (k) => k.team ? <Badge tone="blue">{k.team.name}</Badge> : <span class={s.tokenWhen}>Unassigned</span> },
    { key: 'createdAt', label: 'Created', align: 'right', render: (k) => <span class={s.tokenWhen} title={k.createdAt}>{relativeTime(k.createdAt)}</span> },
    // Copy is gated with the rest: it reveals the LIVE key, which the server refuses to a viewer
    // (a copyable credential is not "read-only" in any sense that matters).
    { key: 'actions', label: '', align: 'right', render: (k) => (canWrite()
      ? (
        <span class={s.rowActions}>
          <CopyButton iconOnly ariaLabel={`Copy ${k.name}`} getValue={() => revealKey(k)}
            onError={(e) => setFormErr(friendlyError(e, 'Could not reveal the key to copy.'))} />
          <Button size="sm" variant="ghost" onClick={() => { setFormErr(null); setReTo(k.team?.id ?? ''); setReassign(k); }} aria-label={`Reassign ${k.name}`}><Shuffle size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={() => { setFormErr(null); setRevoking(k); }} aria-label={`Revoke ${k.name}`}><Trash2 size={13} /></Button>
        </span>
      )
      : null
    ) },
  ];

  return (
    <>
      {canWrite() ? (
        <Card heading="Create an access key">
          <p class={s.setDesc}>
            The credential a team member sends as <code>Authorization: Bearer …</code>. Assign it to a team
            to count its usage against that team’s budget and routing tier. The key is shown once — copy it now.
          </p>
          {formError && <FormError>{formError}</FormError>}
          <div class={s.keyCreateRow}>
            <Input value={name} placeholder="e.g. Abbas, CI pipeline" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <Select value={teamId} onChange={(e) => setTeamId((e.target as HTMLSelectElement).value)} aria-label="Team">
              <option value="">Unassigned</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <Button variant="primary" size="sm" onClick={create} disabled={!name.trim() || creating}>
              <KeyRound size={13} /> {creating ? 'Creating…' : 'Create key'}
            </Button>
          </div>

          {fresh && (
            <div class={s.tokenFresh}>
              <p class={s.tokenFreshWarn}><b>Copy “{fresh.name}” now.</b> This is the only time the full key is shown here.</p>
              <CopyField value={fresh.key} />
            </div>
          )}
        </Card>
      ) : (
        <Card heading="Access keys">
          <p class={s.setDesc}>
            The credentials team members send as <code>Authorization: Bearer …</code>. You can see
            what exists below; creating, copying, or revoking a key needs write access — a key in
            hand spends money, which is more than reading.
          </p>
        </Card>
      )}

      <Card heading="Access keys" class={s.section}>
        {loading && !data && <div class={s.centered}><Spinner /> <span>Loading keys…</span></div>}
        {error && !data && (
          <div class={s.errBody}>
            <p>Couldn’t load keys — {error}.</p>
            <Button size="sm" onClick={reload}>Retry</Button>
          </div>
        )}
        {data && (() => {
          const q = search.trim().toLowerCase();
          const rows = data.keys.filter((k) => {
            const teamOk = filterTeam === '' ? true : filterTeam === 'none' ? k.team == null : k.team?.id === filterTeam;
            const textOk = q === '' ? true : k.name.toLowerCase().includes(q) || k.maskedKey.toLowerCase().includes(q);
            return teamOk && textOk;
          });
          return (
            <>
              <div class={s.keyCreateRow}>
                <Input value={search} placeholder="Search name or key…" onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
                <Select value={filterTeam} onChange={(e) => setFilterTeam((e.target as HTMLSelectElement).value)} aria-label="Filter by team">
                  <option value="">All teams</option>
                  <option value="none">Unassigned</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </div>
              <Table columns={cols} rows={rows} rowKey={(k) => k.id}
                empty={data.keys.length === 0 ? 'No access keys yet.' : 'No keys match this filter.'} />
            </>
          );
        })()}
      </Card>

      {reassign && (
        <Modal
          title={`Reassign ${reassign.name}`}
          onClose={() => !reBusy && setReassign(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReassign(null)} disabled={reBusy}>Cancel</Button>
              <Button variant="primary" onClick={doReassign} disabled={reBusy}>{reBusy ? 'Saving…' : 'Save'}</Button>
            </>
          }
        >
          <Field label="Team">
            <Select value={reassignTo} onChange={(e) => setReTo((e.target as HTMLSelectElement).value)}>
              <option value="">Unassigned</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <p class={s.setDesc} style={{ marginTop: '12px' }}>
            Moving a key changes which team’s budget and routing tier its traffic counts against from now on.
          </p>
        </Modal>
      )}

      {revoking && (
        <Modal
          title="Revoke this key?"
          onClose={() => !revBusy && setRevoking(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRevoking(null)} disabled={revBusy}>Cancel</Button>
              <Button variant="danger" onClick={revoke} disabled={revBusy}>{revBusy ? 'Revoking…' : 'Revoke key'}</Button>
            </>
          }
        >
          <p class={s.setDesc}>
            <b>{revoking.name}</b> ({revoking.maskedKey}) will stop working immediately. Anything using it
            will start getting authentication errors. This cannot be undone.
          </p>
        </Modal>
      )}
    </>
  );
}
