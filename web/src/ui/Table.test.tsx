import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { Table, type Column } from './Table';

interface Row { id: string; name: string; n: number; }
const columns: Column<Row>[] = [
  { key: 'name', label: 'Name' },
  { key: 'n', label: 'Count', align: 'right', render: (r) => `#${r.n}` },
];

describe('Table', () => {
  it('renders headers and rows, using the render function when given', () => {
    render(<Table columns={columns} rows={[{ id: 'a', name: 'Alpha', n: 5 }]} rowKey={(r) => r.id} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('#5')).toBeInTheDocument();
  });

  it('shows the empty state when there are no rows', () => {
    render(<Table columns={columns} rows={[]} rowKey={(r) => r.id} empty="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
