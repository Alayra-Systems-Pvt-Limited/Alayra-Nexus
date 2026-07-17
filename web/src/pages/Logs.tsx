import { useState } from 'preact/hooks';
import { ScrollText } from 'lucide-preact';
import { PageHeader, Card, Table, Badge, Button, Spinner, Input, Select, type Column } from '../ui';
import { useApi } from '../hooks/useApi';
import { relativeTime } from '../lib/format';
import type { AuditEntry } from '../api';
import s from './pages.module.css';

// P7.6: the audit trail, promoted out of Settings into its own section. It is read-only by design —
// the gateway exposes no way to write or delete an entry over HTTP, so a trail cannot be edited
// through the API it is meant to police. Entries leave only when the retention job removes them.
//
// The action slug is shown as-is rather than prettified: it is the stable identifier an operator
// will grep for and quote in an incident, and inventing friendlier names for it would make the
// dashboard and the logs disagree.

const ROLES = [
  { id: '',       label: 'Any actor' },
  { id: 'owner',  label: 'Owner' },
  { id: 'viewer', label: 'Viewer' },
  { id: 'system', label: 'System' },
];

/** A status code, coloured by what it means: refused, failed, or fine. */
function statusTone(status: number): 'green' | 'yellow' | 'red' | 'gray' {
  if (status === 0)            return 'gray';   // written before the response was known
  if (status >= 500)           return 'red';
  if (status === 401 || status === 403) return 'yellow'; // refused on purpose
  if (status >= 400)           return 'yellow';
  return 'green';
}

export function Logs() {
  const [action, setAction] = useState('');
  const [role, setRole]     = useState('');
  const [limit, setLimit]   = useState(50);

  const query = new URLSearchParams();
  if (action.trim()) query.set('action', action.trim());
  if (role)          query.set('actorRole', role);
  query.set('limit', String(limit));

  const { data, loading, error, reload } = useApi<{ entries: AuditEntry[] }>(`/admin/audit?${query.toString()}`);
  const entries = data?.entries ?? [];

  const cols: Column<AuditEntry>[] = [
    { key: 'action', label: 'Action', render: (e) => (
      <div class={s.logAction}>
        <code class={s.logSlug}>{e.action}</code>
        <span class={s.logMethod}>{e.method}</span>
      </div>
    ) },
    { key: 'actorRole', label: 'Actor', render: (e) => (
      // The name leads, the role qualifies it. Accounts landed in 7.13a and the trail has named
      // people since — but this column kept showing only the role, so "the log records names"
      // was true in the database and invisible on screen. No name means there is genuinely
      // nobody: a token-minted session, or an entry from before accounts existed.
      <div class={s.logActor}>
        {e.actorName && <span class={s.logName}>{e.actorName}</span>}
        <Badge tone={e.actorRole === 'owner' ? 'blue' : 'gray'}>{e.actorRole}</Badge>
        {e.actor && !e.actorName && <span class={s.logVia}>via {e.actor}</span>}
      </div>
    ) },
    { key: 'target', label: 'Target', render: (e) => <span class={s.logTarget}>{e.target ?? '—'}</span> },
    { key: 'status', label: 'Result', align: 'right', render: (e) => (
      <Badge tone={statusTone(e.status)}>{e.status || '—'}</Badge>
    ) },
    { key: 'ip', label: 'From', align: 'right', render: (e) => <span class={s.logIp}>{e.ip ?? '—'}</span> },
    { key: 'createdAt', label: 'When', align: 'right', render: (e) => (
      <span class={s.logWhen} title={e.createdAt}>{relativeTime(e.createdAt)}</span>
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle="Every change made to this gateway"
        actions={<Badge tone="gray">read-only</Badge>}
      />

      <Card>
        <div class={s.logFilters}>
          <Input
            value={action}
            placeholder="Filter by action — e.g. keys, settings, auth"
            onInput={(e) => setAction((e.target as HTMLInputElement).value)}
          />
          <Select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
          <Select value={String(limit)} onChange={(e) => setLimit(parseInt((e.target as HTMLSelectElement).value, 10))}>
            {[50, 100, 200].map((n) => <option key={n} value={String(n)}>Last {n}</option>)}
          </Select>
          <Button size="sm" onClick={reload} disabled={loading}>Refresh</Button>
        </div>

        {loading && !data && <div class={s.centered}><Spinner /> <span>Loading the trail…</span></div>}

        {error && (
          <div class={s.errBody}>
            <ScrollText size={22} class={s.errIcon} />
            <p>Couldn’t load the audit trail — {error}.</p>
            <Button size="sm" onClick={reload}>Retry</Button>
          </div>
        )}

        {data && (
          <Table
            columns={cols}
            rows={entries}
            rowKey={(e) => e.id}
            empty={action || role ? 'No entries match that filter' : 'Nothing has been changed yet'}
          />
        )}
      </Card>

      <p class={s.dataNote}>
        The trail records every state-changing action, including the ones that were refused. It cannot
        be edited or deleted through the API — entries leave only when they pass the retention window
        set in Settings → Compliance.
      </p>
    </>
  );
}
