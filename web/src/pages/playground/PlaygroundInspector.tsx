import { Activity, Coins, Gauge, KeyRound, Route, ShieldCheck } from 'lucide-preact';
import type { PlaygroundTrace } from '../../lib/playground';
import s from './playground.module.css';

interface Props { trace?: PlaygroundTrace }

const duration = (value?: number) => value == null ? '--' : value < 1000 ? value + ' ms' : (value / 1000).toFixed(2) + ' s';
const cost = (trace?: PlaygroundTrace) => {
  if (!trace?.usage) return '--';
  if (trace.usage.priced === false) return 'Unpriced';
  return trace.usage.estimatedUsd == null ? '--' : '$' + trace.usage.estimatedUsd.toFixed(4);
};

export function PlaygroundInspector({ trace }: Props) {
  const route = trace?.route;
  const usage = trace?.usage;
  return (
    <aside class={s.inspector} aria-label="Run inspector">
      <header><Route size={15} /><span>Run inspector</span></header>
      {!trace ? (
        <div class={s.inspectorEmpty}><Activity size={20} /><strong>Ready for a run</strong><p>Routing, latency, token usage, and cost will appear here after the first response.</p></div>
      ) : (
        <div class={s.inspectorBody}>
          <section class={s.inspectorRoute}><span>Resolution</span><strong>{route?.modelString ?? 'No route selected'}</strong><small>{route ? route.provider + ' / ' + route.tier : trace.resolution}</small></section>
          <div class={s.inspectorMetrics}>
            <section><Gauge size={13} /><span>Latency</span><strong>{duration(trace.timing.totalMs)}</strong><small>TTFT {duration(trace.timing.ttfbMs)}</small></section>
            <section><Coins size={13} /><span>Cost</span><strong>{cost(trace)}</strong><small>estimated</small></section>
            <section><Activity size={13} /><span>Tokens</span><strong>{usage ? (usage.inputTokens + usage.outputTokens).toLocaleString() : '--'}</strong><small>{usage ? usage.inputTokens + ' in / ' + usage.outputTokens + ' out' : 'not reported'}</small></section>
            <section><KeyRound size={13} /><span>Credential</span><strong>{route?.byok ? 'Team BYOK' : 'Shared pool'}</strong><small>{trace.attempts.length} provider attempt{trace.attempts.length === 1 ? '' : 's'}</small></section>
          </div>
          <div class={s.inspectorPolicy}>
            <span><ShieldCheck size={12} /> {trace.guardrails?.active ? 'Guardrails active' : 'Policy checked'}</span>
            <span>{trace.budget?.checked ? (trace.budget.allowed ? 'Budget allowed' : 'Budget blocked') : 'Cache ' + trace.cache}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
