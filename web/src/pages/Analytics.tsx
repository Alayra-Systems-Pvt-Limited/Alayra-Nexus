import { useState } from 'preact/hooks';
import { Activity, AlertTriangle, Timer, DollarSign, CheckCircle2, PiggyBank, Coins, Gauge } from 'lucide-preact';
import { PageHeader, StatCard, Spinner, Button, Tabs, ChartCard, type TabItem } from '../ui';
import { useApi } from '../hooks/useApi';
import { compactNumber, currency, shortDate } from '../lib/format';
import type { AnalyticsOverview, AnalyticsPeriod } from '../api';
import { CacheSavings } from './analytics/CacheSavings';
import { ByModel, ByProvider, ByModality, ByOutcome } from './analytics/Breakdowns';
import { DayTip, DAY_ACCENTS, type DayMetric } from './analytics/DayTip';
import { UnpricedNotice } from './analytics/UnpricedNotice';
import s from './pages.module.css';

// P7.5: Analytics, live. One aggregate read per window (`/admin/analytics/overview?period=`) feeds
// the whole page — reliability, speed, spend, and what the response cache saved. The page only
// composes; each block is its own component under ./analytics.
//
// None of this could be shown before 7.5a, because failures and cache savings were never written
// down. The note under the stats says so, so an operator reading a suspiciously perfect success
// rate on old data knows exactly why.

const PERIODS: TabItem[] = [
  { id: 'today', label: 'Today' },
  { id: '7d',    label: '7 days' },
  { id: '30d',   label: '30 days' },
  { id: '90d',   label: '90 days' },
];

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const ms  = (v: number) => (v > 0 ? `${compactNumber(v)} ms` : '—');

export function Analytics() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('7d');
  // The period is part of the path, so switching it refetches through the same one seam.
  const { data, loading, error, reload } = useApi<AnalyticsOverview>(`/admin/analytics/overview?period=${period}`);

  const header = (
    <PageHeader
      title="Analytics"
      subtitle="Reliability, speed, spend, and savings"
      actions={<Tabs items={PERIODS} active={period} onChange={(id) => setPeriod(id as AnalyticsPeriod)} />}
    />
  );

  if (loading && !data) {
    return <>{header}<div class={s.centered}><Spinner /> <span>Loading analytics…</span></div></>;
  }

  if (error || !data) {
    return (
      <>
        {header}
        <div class={s.errBody}>
          <Activity size={22} class={s.errIcon} />
          <p>Couldn’t load analytics{error ? ` — ${error}` : ''}.</p>
          <Button size="sm" onClick={reload}>Retry</Button>
        </div>
      </>
    );
  }

  const { totals, byDay } = data;
  const dates = byDay.map((d) => shortDate(d.date));
  const tip   = (active: DayMetric) => (i: number) => <DayTip day={byDay[i]} label={dates[i]} active={active} />;

  // An idle window has nothing to chart. Saying so beats drawing four flat lines and a 0% success
  // rate that looks like an outage.
  if (totals.requests === 0) {
    return (
      <>
        {header}
        <div class={s.errBody}>
          <Activity size={22} class={s.errIcon} />
          <p>No requests in this window. Send traffic through the gateway and it will show up here.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <div class={`${s.grid} ${s.cols4}`}>
        <StatCard label="Requests"     value={compactNumber(totals.requests)}     icon={<Activity size={14} />}      tone={DAY_ACCENTS.requests} sub="every attempt" />
        <StatCard label="Success rate" value={pct(totals.successRate)}            icon={<CheckCircle2 size={14} />}  tone="var(--green)"         sub={`${compactNumber(totals.successes)} served`} />
        <StatCard label="Failed"       value={compactNumber(totals.errors)}       icon={<AlertTriangle size={14} />} tone="var(--red)"           sub="in this window" />
        <StatCard label="Cost"         value={currency(totals.estimatedUsd)}      icon={<DollarSign size={14} />}    tone={DAY_ACCENTS.usd}      sub="estimated spend" />
        <StatCard label="Avg latency"  value={ms(totals.avgLatencyMs)}            icon={<Timer size={14} />}         tone={DAY_ACCENTS.avgLatencyMs} sub="end to end" />
        <StatCard label="95th pct"     value={ms(totals.p95LatencyMs)}            icon={<Gauge size={14} />}         tone={DAY_ACCENTS.avgLatencyMs} sub="slowest 5% start here" />
        <StatCard label="Cache saved"  value={currency(totals.cacheSavedUsd)}     icon={<PiggyBank size={14} />}     tone="var(--green)"         sub={`${pct(totals.cacheHitRate)} hit rate`} />
        <StatCard label="Tokens"       value={compactNumber(totals.totalTokens)}  icon={<Coins size={14} />}         tone="var(--accent)"        sub="input + output" />
      </div>

      <UnpricedNotice />

      <p class={s.dataNote}>
        Success, failure and latency are recorded from release v1.2.0 onward. Requests served before
        it were only ever recorded when they succeeded, so they appear here as successes with no
        latency measured.
      </p>

      <div class={`${s.grid} ${s.cols2} ${s.section}`}>
        <ChartCard title={`Requests · ${period}`}    big={compactNumber(byDay.reduce((a, d) => a + d.requests, 0))} data={byDay.map((d) => d.requests)}     labels={dates} format={compactNumber} accent={DAY_ACCENTS.requests}     tooltip={tip('requests')}     ariaLabel="Requests per day" />
        <ChartCard title={`Failed · ${period}`}      big={compactNumber(byDay.reduce((a, d) => a + d.errors, 0))}   data={byDay.map((d) => d.errors)}       labels={dates} format={compactNumber} accent={DAY_ACCENTS.errors}       tooltip={tip('errors')}       ariaLabel="Failed requests per day" />
        <ChartCard title={`Avg latency · ${period}`} big={ms(totals.avgLatencyMs)}                                  data={byDay.map((d) => d.avgLatencyMs)} labels={dates} format={ms}            accent={DAY_ACCENTS.avgLatencyMs} tooltip={tip('avgLatencyMs')} ariaLabel="Average latency per day" />
        <ChartCard title={`Cost · ${period}`}        big={currency(byDay.reduce((a, d) => a + d.usd, 0))}           data={byDay.map((d) => d.usd)}          labels={dates} format={currency}      accent={DAY_ACCENTS.usd}          tooltip={tip('usd')}          ariaLabel="Cost per day" />
      </div>

      <div class={s.section}>
        <CacheSavings data={data} />
      </div>

      <div class={`${s.grid} ${s.cols2} ${s.section}`}>
        <ByModel rows={data.byModel} />
        <ByProvider rows={data.byProvider} />
        <ByModality rows={data.byModality} />
        <ByOutcome rows={data.byOutcome} />
      </div>
    </>
  );
}
