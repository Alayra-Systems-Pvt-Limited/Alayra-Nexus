import { useState } from 'preact/hooks';
import { PageHeader, Tabs, type TabItem } from '../ui';
import { ServerTab } from './health/ServerTab';
import { ProvidersTab } from './health/ProvidersTab';
import s from './pages.module.css';

// P7.12: the Health section — the gateway's own vitals, distinct from the two sections it is
// easily confused with: Analytics answers "what did the traffic do", Nexus answers "are my
// PROVIDERS healthy"; this answers "is my GATEWAY healthy" — Redis, Postgres, and the Node process
// itself. Server shows the vitals; Providers is a read-only capacity summary that links to Nexus.
// Unfinished tabs stay out of release navigation until they provide something useful.
const TABS: TabItem[] = [
  { id: 'server',     label: 'Server' },
  { id: 'providers',  label: 'Providers' },
];

export function Health() {
  const [tab, setTab] = useState('server');

  return (
    <>
      {/* Engine-neutral on purpose (S2.3). This header renders before the overview is fetched, so it
          cannot name the engines the gateway is actually on — and naming the wrong two is worse than
          naming none. The Storage card and each panel below name them from what the server reports. */}
      <PageHeader title="Health" subtitle="The gateway’s own vitals — process, data stores, and upstream capacity" />
      <div class={s.setTabs}>
        <Tabs items={TABS} active={tab} onChange={setTab} />
      </div>
      {tab === 'server' ? <ServerTab /> : <ProvidersTab />}
    </>
  );
}
