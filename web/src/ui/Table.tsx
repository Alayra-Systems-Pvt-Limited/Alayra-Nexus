import type { ComponentChildren } from 'preact';
import { EmptyState } from './EmptyState';
import s from './ui.module.css';

// A small declarative table primitive shared by every list on the dashboard (activity, keys,
// models, later logs/teams). Columns describe how to render a cell; the table owns the chrome —
// header, zebra rows, right-alignment for numbers, horizontal scroll on narrow screens, and a
// single consistent empty state — so no page hand-rolls a <table>.

export interface Column<T> {
  key:     string;
  label:   string;
  align?:  'left' | 'right';
  render?: (row: T) => ComponentChildren;
}

interface Props<T> {
  columns: Column<T>[];
  rows:    T[];
  rowKey:  (row: T) => string;
  empty?:  string;
}

export function Table<T>({ columns, rows, rowKey, empty = 'Nothing yet' }: Props<T>) {
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div class={s.tableWrap}>
      <table class={s.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} class={c.align === 'right' ? s.tRight : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} class={c.align === 'right' ? s.tRight : undefined}>
                  {c.render ? c.render(row) : (row as Record<string, ComponentChildren>)[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
