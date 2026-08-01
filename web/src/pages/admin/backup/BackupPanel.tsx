import { useState } from 'preact/hooks';
import { LifeBuoy } from 'lucide-preact';
import { useApi } from '../../../hooks/useApi';
import type { HealthOverview } from '../../../api';
import { StoredBackupsCard } from './StoredBackupsCard';
import { ScheduleCard } from './ScheduleCard';
import { ExportCard } from './ExportCard';
import { RestoreWizard } from './RestoreWizard';
import s from './backup.module.css';

// Backup and restore (Phase B1.4, schedule added in B2) — the owner-only tab the whole engine was
// built for.
//
// Three cards, on one screen rather than behind separate tabs, because each is only ever as good as
// the one above it and an operator should see that. The order is deliberate:
//
//  1. AUTOMATIC BACKUPS first, because a gateway that backs itself up is the outcome worth having,
//     and the card that has to be visited once outranks the one visited occasionally. It also makes
//     the alternative obvious: an operator whose only backup is the manual download below can see
//     that fact stated at the top of the page rather than inferring it from an absence.
//  2. TAKE A BACKUP — a copy in your own hands, protected by a passphrase you type. Different from
//     the scheduled file in both where it goes and what opens it, which is why they are separate
//     cards saying so rather than one card with a mode.
//  3. RESTORE, last, because it is the only one that changes anything.
//
// The panel is rendered only for an owner (Admin.tsx), which is presentation, not the boundary:
// every route sits behind adminOwnerGuard and a `replace` additionally demands the master password.

export function BackupPanel() {
  // Only to name the engine a backup would be restored INTO, so a Postgres file arriving on a
  // SQLite gateway reads as the migration it is rather than a mismatch. Deliberately not awaited
  // and never gated on: if this fails, the report simply omits one line. A field read during render
  // that the payload may not carry is exactly how the Connect page came to hang on "Loading…".
  const { data } = useApi<HealthOverview>('/admin/health/overview');

  // One counter, shared by the two cards that read the same state. The schedule card bumps it after
  // a save or a run; the list and the data-loss notice above re-read on the change. Without it the
  // page would report "no backups" directly above a button that had just made one.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);

  return (
    <div class={s.panel}>
      <div class={s.intro}>
        <span class={s.introIcon}><LifeBuoy size={16} /></span>
        <p class={s.introText}>
          A backup is one encrypted file that can rebuild this gateway somewhere else — a new machine,
          a different database engine, or this same server after something went wrong. Provider keys
          travel inside it in a form only the gateway receiving them can open, so nothing here is
          usable by whoever happens to hold the file.
        </p>
      </div>

      <StoredBackupsCard version={version} />
      <ScheduleCard version={version} onChanged={changed} />
      <ExportCard />
      <RestoreWizard targetEngine={data?.backend?.db} />
    </div>
  );
}
