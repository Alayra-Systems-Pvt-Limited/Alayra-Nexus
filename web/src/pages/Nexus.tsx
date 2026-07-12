import { useState } from 'preact/hooks';
import { Boxes, KeyRound, Snowflake, Ban, Plus } from 'lucide-preact';
import { PageHeader, StatCard, Spinner, Button, EmptyState } from '../ui';
import { useApi } from '../hooks/useApi';
import { compactNumber } from '../lib/format';
import type { NexusOverview, ModelsResponse, AiModel } from '../api';
import { RoutingRules } from './nexus/RoutingRules';
import { PoolCard } from './nexus/PoolCard';
import { AddProviderDialog } from './nexus/AddProviderDialog';
import s from './pages.module.css';

const TIER_LABEL: Record<string, string> = { premium: 'Premium tier', standard: 'Standard tier', fast: 'Fast tier' };

// P7.3: the redesigned Nexus section — provider pools grouped by the tier routing walks them in,
// each key's live health with operator actions, and an honest description of the routing rules.
export function Nexus() {
  const { data, loading, error, reload } = useApi<NexusOverview>('/admin/nexus/overview');
  const { data: modelData, reload: reloadModels } = useApi<ModelsResponse>('/admin/models');
  const [adding, setAdding] = useState(false);

  // Reload both the pools and the registry so a model added/removed on a key shows immediately.
  const reloadAll = () => { reload(); reloadModels(); };

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Nexus" subtitle="Provider pools & routing" />
        <div class={s.centered}><Spinner /> <span>Loading pools…</span></div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title="Nexus" subtitle="Provider pools & routing" />
        <div class={s.errBody}>
          <Boxes size={22} class={s.errIcon} />
          <p>Couldn’t load pools{error ? ` — ${error}` : ''}.</p>
          <Button size="sm" onClick={reload}>Retry</Button>
        </div>
      </>
    );
  }

  const { summary, routing, tiers } = data;
  const allModels: AiModel[] = modelData?.models ?? [];
  const modelsFor = (providerSlug: string) => allModels.filter((m) => m.provider === providerSlug);

  return (
    <>
      <PageHeader
        title="Nexus"
        subtitle="Provider pools & routing"
        actions={<Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus size={15} /> Add provider</Button>}
      />

      <div class={`${s.grid} ${s.cols4}`}>
        <StatCard label="Providers"    value={compactNumber(summary.providers)}   icon={<Boxes size={14} />} sub="pools configured" />
        <StatCard label="Active keys"  value={compactNumber(summary.activeKeys)}  icon={<KeyRound size={14} />} sub="ready to serve" />
        <StatCard label="Cooling"      value={compactNumber(summary.coolingKeys)} icon={<Snowflake size={14} />} sub="temporarily rested" />
        <StatCard label="Banned"       value={compactNumber(summary.bannedKeys)}  icon={<Ban size={14} />} sub="need attention" />
      </div>

      <div class={s.section}><RoutingRules costWeight={routing.costWeight} /></div>

      {tiers.length === 0 ? (
        <div class={s.section}>
          <EmptyState icon={<Boxes size={22} />}>No provider pools yet. Add one to start routing.</EmptyState>
          <div class={s.emptyCta}><Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus size={15} /> Add provider</Button></div>
        </div>
      ) : (
        tiers.map((group) => (
          <div key={group.tier} class={s.section}>
            <h3 class={s.tierHeading}>{TIER_LABEL[group.tier] ?? group.tier}</h3>
            <div class={s.poolGrid}>
              {group.providers.map((pool) => <PoolCard key={pool.id} pool={pool} models={modelsFor(pool.provider)} onChanged={reloadAll} />)}
            </div>
          </div>
        ))
      )}

      {adding && <AddProviderDialog onClose={() => setAdding(false)} onCreated={reloadAll} />}
    </>
  );
}
