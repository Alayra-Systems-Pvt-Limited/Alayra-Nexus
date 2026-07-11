import { Card, EmptyState } from '../../ui';
import { compactNumber } from '../../lib/format';
import type { Overview } from '../../api';
import s from '../pages.module.css';

// "Usage by model" for the last 7 days, as a ranked bar list — the quickest read of where the
// tokens are going. Bars are scaled to the busiest model in the window.
export function TopModels({ items }: { items: Overview['topModels'] }) {
  const max = Math.max(1, ...items.map((i) => i.tokens));
  return (
    <Card heading="Top models · 7 days">
      {items.length === 0 ? (
        <EmptyState>No model usage in the last 7 days</EmptyState>
      ) : (
        <ul class={s.rank}>
          {items.map((i) => (
            <li key={i.model} class={s.rankRow}>
              <span class={s.rankName}>{i.model}</span>
              <span class={s.rankBarWrap}><span class={s.rankBar} style={{ width: `${(i.tokens / max) * 100}%` }} /></span>
              <span class={s.rankVal}>{compactNumber(i.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
