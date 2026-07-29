import { useState } from 'preact/hooks';
import { getIdentity } from '../api';
import { PageHeader, Tabs, type TabItem } from '../ui';
import { People } from './admin/People';
import { MyAccount } from './admin/MyAccount';
import { DangerZone } from './admin/DangerZone';
import { BackupPanel } from './admin/backup/BackupPanel';
import s from './pages.module.css';

// The Admin section (Phase 7.13a) — a Placeholder from the day the shell was built, because there
// was nothing to put in it: the gateway had no users. One shared ADMIN_PASSWORD in an environment
// variable authenticated everyone, so nobody could be added or removed, and the audit trail could
// only ever say "someone with the password".
//
// People is owner-managed; My account is each person's own. The Danger zone (7.13b) holds the
// factory reset and is shown only to owners — hiding it from others is presentation, not the
// boundary: the server demands an owner session AND the master password regardless.
//
// Backup (B1.4) joins them for the same reasons, and sits immediately before the Danger zone
// because the two are mirrors: one destroys this gateway, the other rebuilds it. An operator who
// finds the reset should have already passed the thing that makes it survivable.

const TABS: TabItem[] = [
  { id: 'people', label: 'People' },
  { id: 'me',     label: 'My account' },
];

const OWNER_TABS: TabItem[] = [
  ...TABS,
  { id: 'backup', label: 'Backup' },
  { id: 'danger', label: 'Danger zone' },
];

export function Admin() {
  const [tab, setTab] = useState('people');
  const isOwner = getIdentity()?.role === 'owner';

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="The people who administer this gateway, your own account, and this gateway’s data"
      />
      <div class={s.setTabs}>
        <Tabs items={isOwner ? OWNER_TABS : TABS} active={tab} onChange={setTab} />
      </div>
      <div class={s.setPanel}>
        {tab === 'people' ? <People />
          : tab === 'backup' && isOwner ? <BackupPanel />
          : tab === 'danger' && isOwner ? <DangerZone />
          : <MyAccount />}
      </div>
    </>
  );
}
