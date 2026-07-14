import { useState } from 'preact/hooks';
import { PageHeader, Tabs, type TabItem } from '../ui';
import { RoutingPanel } from './settings/RoutingPanel';
import { CachePanel } from './settings/CachePanel';
import { GuardrailsPanel } from './settings/GuardrailsPanel';
import { NotificationsPanel } from './settings/NotificationsPanel';
import { CompliancePanel } from './settings/CompliancePanel';
import { SsrfPanel } from './settings/SsrfPanel';
import { AppearancePanel } from './settings/AppearancePanel';
import s from './pages.module.css';

// P7.6: Settings, live. The old dashboard stacked every one of these into a single scroll; here each
// is a sub-tab that loads and saves only what it owns. Nothing new was needed from the gateway —
// every endpoint behind these panels has existed and been tested since the 6.x phases and was simply
// never reachable from the redesigned dashboard.
const TABS: TabItem[] = [
  { id: 'routing',       label: 'Routing' },
  { id: 'cache',         label: 'Cache' },
  { id: 'guardrails',    label: 'Guardrails' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'network',       label: 'Network' },
  { id: 'compliance',    label: 'Compliance' },
  { id: 'appearance',    label: 'Appearance' },
];

const PANELS: Record<string, () => preact.JSX.Element> = {
  routing:       RoutingPanel,
  cache:         CachePanel,
  guardrails:    GuardrailsPanel,
  notifications: NotificationsPanel,
  network:       SsrfPanel,
  compliance:    CompliancePanel,
  appearance:    AppearancePanel,
};

export function Settings() {
  const [tab, setTab] = useState('routing');
  const Panel = PANELS[tab] ?? RoutingPanel;

  return (
    <>
      <PageHeader title="Settings" subtitle="How the gateway behaves" />
      <div class={s.setTabs}>
        <Tabs items={TABS} active={tab} onChange={setTab} />
      </div>
      <div class={s.setPanel}>
        <Panel />
      </div>
    </>
  );
}
