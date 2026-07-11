import { Card, Table, type Column } from '../../ui';
import { compactNumber, currency } from '../../lib/format';
import type { Overview } from '../../api';

type Key = Overview['topKeys'][number];

// "Usage by access key" for the last 7 days — the team-facing side of the same traffic, so an
// operator can see which keys are driving spend.
const columns: Column<Key>[] = [
  { key: 'name',         label: 'Access key' },
  { key: 'requests',     label: 'Requests', align: 'right', render: (k) => compactNumber(k.requests) },
  { key: 'totalTokens',  label: 'Tokens',   align: 'right', render: (k) => compactNumber(k.totalTokens) },
  { key: 'estimatedUsd', label: 'Cost',     align: 'right', render: (k) => currency(k.estimatedUsd) },
];

export function TopKeys({ items }: { items: Overview['topKeys'] }) {
  return (
    <Card heading="Top access keys · 7 days">
      <Table columns={columns} rows={items} rowKey={(k) => k.id} empty="No key usage in the last 7 days" />
    </Card>
  );
}
