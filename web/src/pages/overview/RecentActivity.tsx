import { Card, Table, Badge, type Column } from '../../ui';
import { relativeTime } from '../../lib/format';
import type { Overview } from '../../api';

type Log = Overview['recentLogs'][number];

// The tail of the audit trail — the most recent state-changing admin actions, so the operator sees
// at a glance what has happened without opening the full Logs section.
function statusTone(status: number): 'green' | 'yellow' | 'red' | 'gray' {
  if (status >= 200 && status < 300) return 'green';
  if (status >= 500)                 return 'red';
  if (status >= 400)                 return 'yellow';
  return 'gray';
}

const columns: Column<Log>[] = [
  { key: 'action',    label: 'Action', render: (l) => l.target ? `${l.action} · ${l.target}` : l.action },
  { key: 'method',    label: 'Method', render: (l) => <Badge tone="gray">{l.method}</Badge> },
  { key: 'actorRole', label: 'Role' },
  { key: 'status',    label: 'Status', render: (l) => <Badge tone={statusTone(l.status)}>{l.status}</Badge> },
  { key: 'createdAt', label: 'When', align: 'right', render: (l) => relativeTime(l.createdAt) },
];

export function RecentActivity({ items }: { items: Overview['recentLogs'] }) {
  return (
    <Card heading="Recent activity">
      <Table columns={columns} rows={items} rowKey={(l) => l.id} empty="No admin activity recorded yet" />
    </Card>
  );
}
