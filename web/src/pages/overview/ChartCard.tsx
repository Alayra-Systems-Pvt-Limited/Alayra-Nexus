import type { ComponentChildren } from 'preact';
import { Card, LineChart } from '../../ui';
import s from '../pages.module.css';

// A titled metric card: a headline figure over its 7-day sparkline. Used four times on the
// Overview, so the shape lives here once rather than being repeated per metric.
interface Props {
  title:     string;
  big:       ComponentChildren;
  data:      number[];
  ariaLabel: string;
}

export function ChartCard({ title, big, data, ariaLabel }: Props) {
  return (
    <Card heading={title} class={s.chartCard}>
      <div class={s.chartHead}><span class={s.chartBig}>{big}</span></div>
      <LineChart data={data} height={120} ariaLabel={ariaLabel} />
    </Card>
  );
}
