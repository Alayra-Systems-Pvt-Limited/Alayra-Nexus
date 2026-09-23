import { Activity, CircleAlert, CircleCheck, Coins, Gauge, KeyRound, Route } from 'lucide-preact';
import type { PlaygroundTrace } from '../../lib/playground';
import s from './playground.module.css';

interface Props { trace: PlaygroundTrace }
const milliseconds = (value?: number) => value == null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
const money = (value: number) => value < 0.0001 && value > 0 ? '<$0.0001' : `$${value.toFixed(4)}`;
const title = (value?: string) => value ? value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Pending';

export function PlaygroundDiagnostics({ trace }: Props) {
  const route = trace.route;
  const usage = trace.usage;
  const cost = usage?.priced === false ? 'Price unavailable' : usage?.estimatedUsd == null ? 'Not recorded' : money(usage.estimatedUsd);
  const successful = trace.outcome === 'success';
  return <details class={s.diagnostics}>
    <summary><span class={s.diagnosticSummary}><Route size={14} /> Routing details</span><span class={successful ? s.outcomeGood : s.outcomeBad}>{successful ? <CircleCheck size={13} /> : <CircleAlert size={13} />}{title(trace.outcome)}</span></summary>
    <div class={s.diagnosticBody}>
      <div class={s.diagnosticGrid}>
        <section><span><Route size={13} /> Route</span><strong>{route?.modelString ?? 'No route selected'}</strong><small>{route ? `${route.provider} · ${route.tier}` : title(trace.resolution)}</small></section>
        <section><span><Gauge size={13} /> Timing</span><strong>{milliseconds(trace.timing.totalMs)}</strong><small>TTFT {milliseconds(trace.timing.ttfbMs)} · upstream {milliseconds(trace.timing.upstreamMs)}</small></section>
        <section><span><Activity size={13} /> Tokens</span><strong>{usage ? (usage.inputTokens + usage.outputTokens).toLocaleString() : '—'}</strong><small>{usage ? `${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out` : 'No usage reported'}</small></section>
        <section><span><Coins size={13} /> Cost and cache</span><strong>{cost}</strong><small>{usage?.priced === false ? 'Model pricing is not configured' : `Cache ${title(trace.cache)}${usage?.savedUsd ? ` · saved ${money(usage.savedUsd)}` : ''}`}</small></section>
      </div>
      {trace.strategy && <p class={s.strategyExplanation}><strong>{title(trace.strategy.applied)} routing.</strong> {trace.strategy.explanation}</p>}
      {route && <div class={s.routeFacts} aria-label="Routing decisions">
        <span>Requested: {trace.requestedModel ?? 'default'}</span><span>{trace.resolution === 'auto' ? 'Auto routed' : 'Model pinned'}</span>
        <span>{route.sticky ? 'Sticky key' : 'Capacity selected'}</span><span>{route.byok ? 'Team BYOK' : 'Shared pool'}</span>
        {route.keyStatus && <span>Key {title(route.keyStatus)}</span>}{route.rpmLimit != null && <span>{route.rpmLimit.toLocaleString()} RPM configured</span>}{route.tpmLimit != null && <span>{route.tpmLimit.toLocaleString()} TPM configured</span>}
        {route.downgraded && <span>Tier downgraded</span>}{route.probe && <span>Breaker probe</span>}{trace.scope?.isolated && <span>Isolated scope</span>}
      </div>}
      {trace.attempts.length > 0 && <section class={s.attempts} aria-label="Execution path"><h4>Execution path <span>{trace.attempts.length}</span></h4>{trace.attempts.map((attempt, index) => <div class={s.attempt} key={`${attempt.provider}-${attempt.keyMask}-${index}`}><span class={s.attemptIndex}>{index + 1}</span><div><strong>{attempt.provider} · {attempt.modelString}</strong><small><KeyRound size={11} /> {attempt.keyMask} · {attempt.tier}</small></div><div class={s.attemptResult}><strong>{title(attempt.outcome)}</strong><small>{attempt.status ? `HTTP ${attempt.status} · ` : ''}{milliseconds(attempt.ttfbMs)}</small></div></div>)}</section>}
      {(trace.guardrails?.active || trace.budget?.checked || trace.refusal) && <section class={s.policyFacts}>{trace.guardrails?.active && <p><strong>Guardrails:</strong> input {trace.guardrails.input}, output {trace.guardrails.output}</p>}{trace.budget?.checked && <p><strong>Budget:</strong> {trace.budget.allowed ? 'allowed' : 'blocked'} · {trace.budget.action}</p>}{trace.refusal && <p class={s.refusal}><strong>Refused ({trace.refusal.status}):</strong> {trace.refusal.reason}</p>}</section>}
    </div>
  </details>;
}
