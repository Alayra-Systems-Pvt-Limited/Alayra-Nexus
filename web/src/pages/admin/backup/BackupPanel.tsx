import { LifeBuoy } from 'lucide-preact';
import { useApi } from '../../../hooks/useApi';
import type { HealthOverview } from '../../../api';
import { ExportCard } from './ExportCard';
import { RestoreWizard } from './RestoreWizard';
import s from './backup.module.css';

// Backup and restore (Phase B1.4) — the owner-only tab the whole B1 engine was built for.
//
// Two cards, in the order the work happens: take a backup, then restore one. They are deliberately
// on the same screen rather than behind separate tabs, because the second is only ever as good as
// the first, and an operator who has never pressed the top button should see that fact.
//
// The panel is rendered only for an owner (Admin.tsx), which is presentation, not the boundary:
// both routes sit behind adminOwnerGuard and a `replace` additionally demands the master password.

export function BackupPanel() {
  // Only to name the engine a backup would be restored INTO, so a Postgres file arriving on a
  // SQLite gateway reads as the migration it is rather than a mismatch. Deliberately not awaited
  // and never gated on: if this fails, the report simply omits one line. A field read during render
  // that the payload may not carry is exactly how the Connect page came to hang on "Loading…".
  const { data } = useApi<HealthOverview>('/admin/health/overview');

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

      <ExportCard />
      <RestoreWizard targetEngine={data?.backend?.db} />
    </div>
  );
}
