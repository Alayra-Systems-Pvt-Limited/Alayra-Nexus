import { useState } from 'preact/hooks';
import { Users, Plus, Pencil, Trash2, Coins } from 'lucide-preact';
import { POST, PATCH, DEL, ApiError, type TeamRow, type TeamDraft, type TeamTier, type TeamPeriod, type TeamOverBudgetAction } from '../../api';
import { Card, Button, Badge, Spinner, StatCard, Table, Field, Input, Select, FieldRow, Toggle, FormError, Modal, type Column } from '../../ui';
import { useApi } from '../../hooks/useApi';
import { currency } from '../../lib/format';
import { canWrite } from '../../lib/access';
import s from '../pages.module.css';

// The teams themselves: create, edit budget/tier/status, delete. The preferred tier is a real routing
// input now (Phase 8) — a team set to "fast" is served a fast model first, then falls through the
// normal order if that tier is momentarily exhausted, so a preference never becomes an outage.

const TIER_LABEL: Record<TeamTier, string> = { premium: 'Premium', standard: 'Standard', fast: 'Fast' };
const PERIOD_WORD: Record<TeamPeriod, string> = { daily: 'day', weekly: 'week', monthly: 'month' };

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return 'Your session is read-only (viewer). An owner credential is required to manage teams.';
  }
  return err instanceof ApiError ? err.message : fallback;
}

const emptyDraft = (): TeamDraft => ({
  name: '', status: 'active', assignedTier: null, budgetUsd: null, budgetPeriod: 'monthly', overBudgetAction: 'block', byokFallback: true,
});

const OVER_BUDGET_HINT: Record<TeamOverBudgetAction, string> = {
  block:     'At the cap, refuse new requests (429) until the window resets.',
  notify:    'A soft cap: keep serving and only send the budget alert — never block.',
  downgrade: 'Keep serving once over budget, but force the cheapest (fast) tier to slow the spend.',
};

export function TeamsList() {
  const { data, loading, error, reload } = useApi<{ teams: TeamRow[] }>('/admin/teams');

  const [editing, setEditing]   = useState<TeamRow | null>(null); // the row being edited (null when creating)
  const [draft, setDraft]       = useState<TeamDraft | null>(null); // non-null while the form modal is open
  const [saving, setSaving]     = useState(false);
  const [formError, setFormErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TeamRow | null>(null);
  const [delBusy, setDelBusy]   = useState(false);

  const openCreate = () => { setEditing(null); setFormErr(null); setDraft(emptyDraft()); };
  const openEdit = (t: TeamRow) => {
    setEditing(t); setFormErr(null);
    // Seeded from the ROW, never a default: hardcoding byokFallback here once meant that editing a
    // team's name silently re-enabled shared-pool fallback on a BYOK-isolated team — an isolation
    // breach dressed as a rename. (?? true guards rows cached from before the server sent the field.)
    setDraft({ name: t.name, status: t.status, assignedTier: t.assignedTier, budgetUsd: t.budgetUsd, budgetPeriod: t.budgetPeriod, overBudgetAction: t.overBudgetAction, byokFallback: t.byokFallback ?? true });
  };

  const patchDraft = (over: Partial<TeamDraft>) => setDraft((d) => (d ? { ...d, ...over } : d));

  const save = async () => {
    if (!draft || !draft.name.trim() || saving) return;
    setSaving(true); setFormErr(null);
    const body = { ...draft, name: draft.name.trim() };
    try {
      if (editing) await PATCH(`/admin/teams/${editing.id}`, body);
      else         await POST('/admin/teams', body);
      setDraft(null); reload();
    } catch (e) { setFormErr(friendlyError(e, 'Could not save the team.')); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!deleting || delBusy) return;
    setDelBusy(true); setFormErr(null);
    try { await DEL(`/admin/teams/${deleting.id}`); setDeleting(null); reload(); }
    catch (e) { setFormErr(friendlyError(e, 'Could not delete the team.')); setDeleting(null); }
    finally { setDelBusy(false); }
  };

  const teams = data?.teams ?? [];
  const totalKeys  = teams.reduce((n, t) => n + t.keyCount, 0);
  const totalSpend = teams.reduce((n, t) => n + t.spendUsd, 0);

  const ACTION_WORD: Record<TeamOverBudgetAction, string> = { block: '', notify: 'soft cap', downgrade: 'downgrades' };
  const budgetCell = (t: TeamRow) => {
    if (t.budgetUsd == null) return <span class={s.tokenWhen}>{currency(t.spendUsd)} · no cap</span>;
    const over = t.spendUsd >= t.budgetUsd;
    const action = ACTION_WORD[t.overBudgetAction];
    return (
      <span class={s.tokenWhen} style={over ? { color: 'var(--red)' } : undefined}>
        {currency(t.spendUsd)} / {currency(t.budgetUsd)} <span class={s.tokenMask}>/{PERIOD_WORD[t.budgetPeriod]}{action ? ` · ${action}` : ''}</span>
      </span>
    );
  };

  const cols: Column<TeamRow>[] = [
    { key: 'name', label: 'Name', render: (t) => <span class={s.tokenName}>{t.name}</span> },
    { key: 'assignedTier', label: 'Routing tier', render: (t) =>
      t.assignedTier ? <Badge tone="blue">{TIER_LABEL[t.assignedTier]}</Badge> : <span class={s.tokenWhen}>Default order</span> },
    { key: 'budget', label: 'Spend / budget', render: budgetCell },
    { key: 'keyCount', label: 'Keys', align: 'right', render: (t) => <span class={s.tokenWhen}>{t.keyCount}</span> },
    { key: 'status', label: 'Status', render: (t) => <Badge tone={t.status === 'active' ? 'green' : 'yellow'}>{t.status}</Badge> },
    { key: 'actions', label: '', align: 'right', render: (t) => (canWrite()
      ? (
        <span class={s.rowActions}>
          <Button size="sm" variant="ghost" onClick={() => openEdit(t)} aria-label={`Edit ${t.name}`}><Pencil size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={() => { setFormErr(null); setDeleting(t); }} aria-label={`Delete ${t.name}`}><Trash2 size={13} /></Button>
        </span>
      )
      : null
    ) },
  ];

  return (
    <>
      <div class={`${s.grid} ${s.cols3}`}>
        <StatCard label="Teams" value={teams.length} sub="groups defined" icon={<Users size={15} />} tone="var(--blue)" />
        <StatCard label="Access keys" value={totalKeys} sub="issued across teams" icon={<Users size={15} />} tone="var(--accent)" />
        <StatCard label="Spend this period" value={currency(totalSpend)} sub="all teams, current window" icon={<Coins size={15} />} tone="var(--green)" />
      </div>

      <Card class={s.section}>
        <div class={s.listHead}>
          <span class={s.listHeadTitle}>Teams</span>
          {canWrite() && <Button variant="primary" size="sm" onClick={openCreate}><Plus size={13} /> New team</Button>}
        </div>
        {loading && !data && <div class={s.centered}><Spinner /> <span>Loading teams…</span></div>}
        {error && !data && (
          <div class={s.errBody}>
            <p>Couldn’t load teams — {error}.</p>
            <Button size="sm" onClick={reload}>Retry</Button>
          </div>
        )}
        {data && <Table columns={cols} rows={teams} rowKey={(t) => t.id} empty="No teams yet. Create one to group keys under a budget." />}
      </Card>

      {draft && (
        <Modal
          title={editing ? `Edit ${editing.name}` : 'New team'}
          onClose={() => !saving && setDraft(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={!draft.name.trim() || saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create team'}</Button>
            </>
          }
        >
          {formError && <FormError>{formError}</FormError>}
          <Field label="Name"><Input value={draft.name} placeholder="e.g. Frontend, Data Science" onInput={(e) => patchDraft({ name: (e.target as HTMLInputElement).value })} /></Field>
          <FieldRow>
            <Field label="Routing tier" hint="preferred, not forced">
              <Select value={draft.assignedTier ?? ''} onChange={(e) => patchDraft({ assignedTier: ((e.target as HTMLSelectElement).value || null) as TeamTier | null })}>
                <option value="">Default order</option>
                <option value="premium">Premium</option>
                <option value="standard">Standard</option>
                <option value="fast">Fast</option>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={draft.status} onChange={(e) => patchDraft({ status: (e.target as HTMLSelectElement).value as 'active' | 'suspended' })}>
                <option value="active">active</option>
                <option value="suspended">suspended</option>
              </Select>
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Budget (USD)" hint="blank = unlimited">
              <Input type="number" min="0" step="0.01" value={draft.budgetUsd ?? ''} placeholder="unlimited"
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  const n = Number.parseFloat(v);
                  patchDraft({ budgetUsd: v === '' || Number.isNaN(n) ? null : n });
                }} />
            </Field>
            <Field label="Budget period">
              <Select value={draft.budgetPeriod} onChange={(e) => patchDraft({ budgetPeriod: (e.target as HTMLSelectElement).value as TeamPeriod })}>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </Select>
            </Field>
          </FieldRow>
          <Field label="When the budget is reached" hint={draft.budgetUsd == null ? 'Set a budget above for this to take effect' : OVER_BUDGET_HINT[draft.overBudgetAction]}>
            <Select value={draft.overBudgetAction} onChange={(e) => patchDraft({ overBudgetAction: (e.target as HTMLSelectElement).value as TeamOverBudgetAction })}>
              <option value="block">Block new requests</option>
              <option value="notify">Notify only (soft cap)</option>
              <option value="downgrade">Downgrade to the fast tier</option>
            </Select>
          </Field>
          <div class={s.section} style={{ marginTop: '14px' }}>
            <Toggle
              checked={draft.byokFallback}
              onChange={(v) => patchDraft({ byokFallback: v })}
              label="Fall back to the shared pool"
              hint="When this team brings its own provider keys, may its traffic use the shared pool once those keys are exhausted? Off = hard isolation (a 503 instead). Ignored for teams that own no keys."
            />
          </div>
          <p class={s.setDesc} style={{ marginTop: '14px' }}>
            The routing tier is a preference: a team’s tier is tried first, then the normal
            premium → standard → fast failover, so a busy tier never blocks the team.
          </p>
        </Modal>
      )}

      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          onClose={() => !delBusy && setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={delBusy}>Cancel</Button>
              <Button variant="danger" onClick={remove} disabled={delBusy}>{delBusy ? 'Deleting…' : 'Delete team'}</Button>
            </>
          }
        >
          <p class={s.setDesc}>
            <b>{deleting.name}</b> will be removed. Its access keys keep working but lose this budget cap
            (they become unscoped). Any provider keys the team brought itself (BYOK) are destroyed with
            it — a private credential is never released into the shared pool. This cannot be undone.
          </p>
        </Modal>
      )}
    </>
  );
}
