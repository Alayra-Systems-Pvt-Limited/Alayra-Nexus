import { Upload, Loader2, ServerCog } from 'lucide-preact';
import { Button } from '../../../ui';
import type { MaintenanceView } from '../../../api';
import { bytes, duration } from '../../../lib/format';
import s from './backup.module.css';

// A restore in flight (Phase B1.4).
//
// Two phases, and they are genuinely different work, so they are drawn as two:
//
//  1. UPLOADING — the browser measures this exactly, so the bar is a real percentage and the abort
//     is a real abort: the gateway does not begin reading until the last part has arrived.
//  2. WORKING — the browser can no longer see anything, so the numbers come from the gateway's own
//     progress flag, polled while the request is in flight.
//
// ── Why the second bar is sometimes a spinner ─────────────────────────────────────────────────
//
// The gateway publishes progress only for a `replace`, because the flag that carries it is the same
// flag that refuses API traffic (A4) — and a merge has no business taking the gateway offline. So a
// merge and a dry run genuinely have no percentage available, and this shows elapsed time and says
// what it is doing instead of animating a bar to a number nobody measured. A progress bar that is
// really a spinner wearing a percentage is the one thing worse than a spinner.

interface Props {
  phase: 'uploading' | 'working';
  /** 0…1, measured by the browser. */
  uploadFraction: number;
  fileSize: number;
  /** The gateway's own progress. Null when it publishes none — see above. */
  maintenance: MaintenanceView | null;
  /** Seconds since the upload finished, for the phases with no percentage. */
  elapsedSeconds: number;
  dryRun: boolean;
  mode: 'merge' | 'replace';
  /** Offered during the upload only. Withdrawn once there is nothing left that stopping could undo. */
  onAbort?: () => void;
}

export function RestoreProgress({
  phase, uploadFraction, fileSize, maintenance, elapsedSeconds, dryRun, mode, onAbort,
}: Props) {
  const uploading = phase === 'uploading';
  const percent = uploading
    ? Math.round(uploadFraction * 100)
    : maintenance?.percent != null ? Math.round(maintenance.percent) : null;

  const title = uploading
    ? 'Uploading the backup'
    : dryRun
      ? 'Checking the backup'
      : mode === 'replace' ? 'Replacing everything' : 'Merging what is missing';

  const detail = uploading
    ? `${bytes(uploadFraction * fileSize)} of ${bytes(fileSize)}`
    : maintenance?.rowsExpected
      ? `${maintenance.rowsWritten.toLocaleString('en-US')} of ${maintenance.rowsExpected.toLocaleString('en-US')} rows`
      : dryRun
        ? 'Reading and authenticating every row. Nothing is being written.'
        : 'Working through the file inside a single transaction.';

  return (
    <div class={s.progress}>
      <div class={s.progressHead}>
        <span class={s.progressIcon}>
          {uploading ? <Upload size={16} /> : mode === 'replace' && !dryRun ? <ServerCog size={16} /> : <Loader2 size={16} class={s.spin} />}
        </span>
        <div class={s.progressText}>
          <h4 class={s.progressTitle}>{title}</h4>
          <p class={s.progressDetail}>{detail}</p>
        </div>
        {percent !== null && <span class={s.progressPercent}>{percent}%</span>}
      </div>

      {/* One element, two behaviours: a measured width, or a travelling sweep when there is no
          number. Never a width that was invented to look busy. */}
      <div
        class={s.bar}
        role="progressbar"
        aria-label={title}
        {...(percent !== null
          ? { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }
          : {})}
      >
        {percent !== null
          ? <div class={s.barFill} style={{ width: `${percent}%` }} />
          : <div class={s.barSweep} />}
      </div>

      <div class={s.progressFoot}>
        <span class={s.progressWhen}>
          {uploading
            ? 'The gateway has not started yet — it reads nothing until the whole file has arrived.'
            : maintenance?.etaSeconds != null
              ? `About ${duration(maintenance.etaSeconds)} left`
              : elapsedSeconds > 0
                ? `${duration(elapsedSeconds)} so far`
                : 'Starting…'}
        </span>
        {uploading && onAbort && (
          <Button size="sm" variant="ghost" onClick={onAbort}>Stop the upload</Button>
        )}
      </div>

      {!uploading && !dryRun && (
        <p class={s.progressWarn}>
          Closing this tab will not stop the restore — it runs to completion or rolls back entirely
          on the gateway. You would only lose this report.
        </p>
      )}
    </div>
  );
}
