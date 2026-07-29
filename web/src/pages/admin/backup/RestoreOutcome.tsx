import { CheckCircle2, LogIn, RotateCcw } from 'lucide-preact';
import { Button } from '../../../ui';
import { clearToken, type RestoreReport } from '../../../api';
import s from './backup.module.css';

// What a finished restore actually did (Phase B1.4).
//
// The counts are the point. A restore that reports "done" and nothing else is indistinguishable from
// one that wrote nothing, and under `merge` writing nothing is a perfectly ordinary outcome — every
// row was already here. Showing rows written next to rows skipped is what tells those two apart.

const exact = (n: number) => n.toLocaleString('en-US');

export function RestoreOutcome({ report, onStartOver }: { report: RestoreReport; onStartOver: () => void }) {
  const replaced = report.mode === 'replace';

  // The session this request rode in on died with the rest of the key-value store. Said plainly, and
  // acted on only when the operator chooses: an automatic redirect would snatch the report away
  // before it could be read, and this is the last place these numbers exist.
  const signOut = () => {
    clearToken();
    window.location.assign('/');
  };

  return (
    <div class={s.outcome}>
      <div class={s.outcomeHead}>
        <span class={s.outcomeIcon}><CheckCircle2 size={20} /></span>
        <div>
          <h4 class={s.outcomeTitle}>
            {replaced ? 'This gateway is now the backup' : 'Merged what was missing'}
          </h4>
          <p class={s.outcomeSub}>
            From Alayra Nexus {report.gatewayVersion}, taken {new Date(report.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
          </p>
        </div>
      </div>

      <div class={s.tiles}>
        <div class={s.tile}>
          <span class={s.tileLabel}>Rows written</span>
          <span class={s.tileValue}>{exact(report.totalWritten)}</span>
          <span class={s.tileSub}>of {exact(report.totalRowsInFile)} in the file</span>
        </div>
        <div class={s.tile}>
          <span class={s.tileLabel}>Secrets re-keyed</span>
          <span class={s.tileValue}>{exact(report.secretsRekeyed)}</span>
          <span class={s.tileSub}>
            {report.secretsRekeyed === 0 ? 'this backup carried none' : 'now sealed with this gateway’s key'}
          </span>
        </div>
        {replaced ? (
          <div class={s.tile}>
            <span class={s.tileLabel}>Tables emptied</span>
            <span class={s.tileValue}>{exact(report.tablesCleared)}</span>
            <span class={s.tileSub}>before the first row was loaded</span>
          </div>
        ) : (
          <div class={s.tile}>
            <span class={s.tileLabel}>Rows skipped</span>
            <span class={s.tileValue}>{exact(report.totalSkipped)}</span>
            <span class={s.tileSub}>already here, and left as they were</span>
          </div>
        )}
      </div>

      {!replaced && report.totalSkipped > 0 && (
        <p class={s.outcomeNote}>
          A merge never overwrites, so {exact(report.totalSkipped)} rows in the file were left out —
          this gateway already had a row with the same identity. That is the expected outcome when
          you merge a backup into a gateway the data came from.
        </p>
      )}

      {report.missingEnv.length > 0 && (
        <p class={s.outcomeNote}>
          Still missing from this server’s environment: {report.missingEnv.map((n) => <code key={n} class={s.chip}>{n}</code>)}.
          The data arrived; whatever depends on these stays dead until you set them and restart.
        </p>
      )}

      <div class={s.actions}>
        {replaced ? (
          <>
            <Button variant="primary" onClick={signOut}><LogIn size={14} /> Sign in again</Button>
            <span class={s.actionNote}>
              Every session was cleared, including yours — {exact(report.kvKeysCleared)} keys in all.
              Sign in with an account from the backup you just restored, not the one you had before.
            </span>
          </>
        ) : (
          <Button onClick={onStartOver}><RotateCcw size={14} /> Restore another backup</Button>
        )}
      </div>
    </div>
  );
}
