import { useState } from 'preact/hooks';
import { Plus, X } from 'lucide-preact';
import { Input, Button } from '../../ui';
import s from '../pages.module.css';

// A small name/value editor for a provider's extra request headers (e.g. anthropic-version). Kept
// self-contained so both the Add- and Edit-provider dialogs use one editor. It manages its own row
// list (so a half-typed blank row is allowed) and reports the assembled object up on every change,
// dropping rows whose name is blank.
type Row = { name: string; value: string };

const toRows = (obj: Record<string, string>): Row[] => {
  const rows = Object.entries(obj).map(([name, value]) => ({ name, value }));
  return rows.length ? rows : [{ name: '', value: '' }];
};

const toObject = (rows: Row[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) { const n = r.name.trim(); if (n) out[n] = r.value; }
  return out;
};

export function HeaderRows({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));

  const apply = (next: Row[]) => { setRows(next); onChange(toObject(next)); };
  const update = (i: number, patch: Partial<Row>) => apply(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => apply(rows.filter((_, j) => j !== i).length ? rows.filter((_, j) => j !== i) : [{ name: '', value: '' }]);
  const add    = () => setRows((rs) => [...rs, { name: '', value: '' }]);

  return (
    <div class={s.headerRows}>
      {rows.map((r, i) => (
        <div class={s.headerRow} key={i}>
          <Input value={r.name} placeholder="anthropic-version" onInput={(e) => update(i, { name: (e.target as HTMLInputElement).value })} />
          <Input value={r.value} placeholder="2023-06-01" onInput={(e) => update(i, { value: (e.target as HTMLInputElement).value })} />
          <button type="button" class={s.headerRowDel} onClick={() => remove(i)} aria-label="Remove header"><X size={13} /></button>
        </div>
      ))}
      <Button variant="ghost" size="sm" class={s.headerAdd} onClick={add}><Plus size={13} /> Add header</Button>
    </div>
  );
}
