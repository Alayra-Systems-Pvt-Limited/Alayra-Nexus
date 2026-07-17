import { CopyButton } from './CopyButton';
import s from './ui.module.css';

/** A monospace value with a one-click copy — used for base URLs, keys, and IDs. The copy behaviour
 *  (and its animated confirmation) lives in CopyButton; this is just its labelled row wrapper. */
export function CopyField({ label, value }: { label?: string; value: string }) {
  return (
    <div class={s.copy}>
      {label && <span class={s.copyLabel}>{label}</span>}
      <span class={s.copyVal}>{value}</span>
      <CopyButton value={value} label="Copy" />
    </div>
  );
}
