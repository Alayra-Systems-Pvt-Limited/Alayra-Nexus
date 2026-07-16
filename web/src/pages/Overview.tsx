import { Activity, ArrowDownUp, KeyRound, Cpu, Users, DollarSign } from 'lucide-preact';
import { PageHeader, StatCard, Badge, Spinner, Button, ChartCard } from '../ui';
import { useApi } from '../hooks/useApi';
import { compactNumber, currency, shortDate } from '../lib/format';
import type { Overview as OverviewData } from '../api';
import { TopModels } from './overview/TopModels';
import { TopKeys } from './overview/TopKeys';
import { RecentActivity } from './overview/RecentActivity';
import { DayTooltip } from './overview/DayTooltip';
import { CHART_ACCENTS, type ChartMetric } from './overview/chartColors';
import s from './pages.module.css';

// P7.2: the Overview is now live. One aggregate read (`/admin/overview`) feeds the headline stat
// cards, four 7-day trend charts, the model/key leaderboards, and the recent-activity trail. The
// page only composes — each block is its own small component under ./overview.
export function Overview() {
  const { data, loading, error, reload } = useApi<OverviewData>('/admin/overview');

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Real-time gateway telemetry" />
        <div class={s.centered}><Spinner /> <span>Loading telemetry…</span></div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title="Overview" subtitle="Real-time gateway telemetry" />
        <div class={s.errBody}>
          <Activity size={22} class={s.errIcon} />
          <p>Couldn’t reach the gateway{error ? ` — ${error}` : ''}.</p>
          <Button size="sm" onClick={reload}>Retry</Button>
        </div>
      </>
    );
  }

  const { stats, series7d, topModels, topKeys, recentLogs } = data;
  const sum = (pick: (d: OverviewData['series7d'][number]) => number) => series7d.reduce((a, d) => a + pick(d), 0);
  const dates = series7d.map((d) => shortDate(d.date));
  // Every chart's hover shows the whole day; only the `active` metric differs per card.
  const dayTip = (active: ChartMetric) => (i: number) => <DayTooltip day={series7d[i]} label={dates[i]} active={active} />;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Real-time gateway telemetry"
        actions={<Badge tone="green" dot>Live</Badge>}
      />

      <div class={`${s.grid} ${s.cols4}`}>
        <StatCard label="Total usage"   value={compactNumber(stats.totalRequests)} icon={<Activity size={14} />}    tone={CHART_ACCENTS.requests}     sub="requests to date"  href="/analytics" />
        <StatCard label="Input tokens"  value={compactNumber(stats.inputTokens7d)} icon={<ArrowDownUp size={14} />} tone={CHART_ACCENTS.inputTokens}  sub="last 7 days"        href="/analytics" />
        <StatCard label="Output tokens" value={compactNumber(stats.outputTokens7d)} icon={<ArrowDownUp size={14} />} tone={CHART_ACCENTS.outputTokens} sub="last 7 days"       href="/analytics" />
        <StatCard label="Total cost"    value={currency(stats.totalCostUsd)}       icon={<DollarSign size={14} />}  tone={CHART_ACCENTS.usd}          sub="to date"           href="/analytics" />
        <StatCard label="Active keys"   value={compactNumber(stats.activeKeys)}    icon={<KeyRound size={14} />}    sub="across pools"      href="/nexus" />
        {/* Points at Nexus, not a /models page: the standalone registry was folded into Nexus in
            P7.4b (a pool owns its own models), and this link was left behind pointing at a route
            that no longer exists — every click landed on "Not found". */}
        <StatCard label="Active models" value={compactNumber(stats.activeModels)}  icon={<Cpu size={14} />}         sub="across pools"     href="/nexus" />
        <StatCard label="Active teams"  value={compactNumber(stats.activeTeams)}   icon={<Users size={14} />}       sub="with access keys" href="/teams" />
        <StatCard label="Status"        value="Live"                               icon={<Activity size={14} />}    sub="all systems"      href="/security" />
      </div>

      <div class={`${s.grid} ${s.cols2} ${s.section}`}>
        <ChartCard title="Input tokens · last 7 days"  big={compactNumber(sum((d) => d.inputTokens))}  data={series7d.map((d) => d.inputTokens)}  labels={dates} format={compactNumber} accent={CHART_ACCENTS.inputTokens}  tooltip={dayTip('inputTokens')}  ariaLabel="Input tokens over the last 7 days" />
        <ChartCard title="Output tokens · last 7 days" big={compactNumber(sum((d) => d.outputTokens))} data={series7d.map((d) => d.outputTokens)} labels={dates} format={compactNumber} accent={CHART_ACCENTS.outputTokens} tooltip={dayTip('outputTokens')} ariaLabel="Output tokens over the last 7 days" />
        <ChartCard title="Requests · last 7 days"      big={compactNumber(sum((d) => d.requests))}     data={series7d.map((d) => d.requests)}     labels={dates} format={compactNumber} accent={CHART_ACCENTS.requests}     tooltip={dayTip('requests')}     ariaLabel="Requests over the last 7 days" />
        <ChartCard title="Cost · last 7 days"          big={currency(sum((d) => d.usd))}               data={series7d.map((d) => d.usd)}          labels={dates} format={currency}       accent={CHART_ACCENTS.usd}          tooltip={dayTip('usd')}          ariaLabel="Cost over the last 7 days" />
      </div>

      <div class={`${s.grid} ${s.cols2} ${s.section}`}>
        <TopModels items={topModels} />
        <TopKeys items={topKeys} />
      </div>

      <div class={s.section}>
        <RecentActivity items={recentLogs} />
      </div>
    </>
  );
}
