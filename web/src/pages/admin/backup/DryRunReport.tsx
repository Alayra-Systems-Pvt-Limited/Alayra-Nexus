import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Database, Info, Layers, KeySquare } from 'lucide-preact';
import { Badge } from '../../../ui';
import type { RestoreReport, SchemaDifference } from '../../../api';
import { relativeTime } from '../../../lib/format';
import s from './backup.module.css';

// What a dry run found (Phase B1.4).
//
// The engine has spent four phases learning to answer questions an operator would otherwise only
// discover afterwards — which rows a merge would silently drop (A1), which settings the source had
// that this gateway does not (C5), how far the schema has moved since the file was written (C4).
// None of that is worth anything if the dashboard renders a row count and a tick.
//
// So this is deliberately not a summary. Everything the server volunteered is shown, ordered by how
// much it should change the operator's mind, and each finding says what it MEANS rather than what it
// is: "12 rows would be skipped" is data, "a merge keeps the row already here, so these 12 stay as
// they are" is the answer to the question they actually have.

/** Exact, never abbreviated. "1.2K rows" is the wrong unit for a decision about data loss. */
const exact = (n: number) => n.toLocaleString('en-US');

/** An absolute timestamp, for a report someone may read months later out of an audit trail. */
function takenAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const ENGINE_LABEL: Record<string, string> = { postgres: 'PostgreSQL', sqlite: 'SQLite' };
const engineName = (id: string) => ENGINE_LABEL[id] ?? id;

/** Drift kinds, phrased as what the restore will DO about them rather than what they are. */
const DRIFT_LABEL: Record<SchemaDifference['kind'], string> = {
  'unknown-model':    'not in this version',
  'new-model':        'left empty',
  'unknown-column':   'not in this version',
  'missing-required': 'cannot be filled',
  'missing-fillable': 'takes its default',
  'type-changed':     'type changed',
  'now-required':     'now required',
};

interface Props {
  report: RestoreReport;
  /** This gateway's database, from the health payload. Omitted when it could not be read. */
  targetEngine?: string;
}

export function DryRunReport({ report, targetEngine }: Props) {
  const models = Object.entries(report.rowsInFile).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const crossEngine = !!targetEngine && targetEngine !== report.sourceEngine;
  const findings = report.collisions.length + report.missingEnv.length + report.schemaDrift.length;

  return (
    <div class={s.report}>
      {/* Where this file came from. First, because every other number is qualified by it. */}
      <div class={s.provenance}>
        <div class={s.provItem}>
          <span class={s.provLabel}>Written by</span>
          <span class={s.provValue}>Alayra Nexus {report.gatewayVersion}</span>
        </div>
        <div class={s.provItem}>
          <span class={s.provLabel}><Clock size={12} /> Taken</span>
          <span class={s.provValue} title={takenAt(report.createdAt)}>
            {relativeTime(report.createdAt)} <span class={s.provMuted}>· {takenAt(report.createdAt)}</span>
          </span>
        </div>
        <div class={s.provItem}>
          <span class={s.provLabel}><Database size={12} /> Store</span>
          <span class={s.provValue}>
            {engineName(report.sourceEngine)}
            {crossEngine && (
              <>
                {' '}<ArrowRight size={12} class={s.provArrow} /> {engineName(targetEngine)}
                <span class={s.provNote}>rows are re-written for this engine</span>
              </>
            )}
          </span>
        </div>
      </div>

      <div class={s.tiles}>
        <div class={s.tile}>
          <span class={s.tileLabel}><Layers size={12} /> Rows in the file</span>
          <span class={s.tileValue}>{exact(report.totalRowsInFile)}</span>
          <span class={s.tileSub}>across {models.length} {models.length === 1 ? 'table' : 'tables'}</span>
        </div>
        <div class={s.tile}>
          <span class={s.tileLabel}><KeySquare size={12} /> Secrets</span>
          <span class={s.tileValue}>{exact(report.secretsInFile)}</span>
          {/* "0 — re-encrypted with this gateway's key" reads like a failure to re-encrypt something.
              At zero the honest statement is that the backup holds no credentials yet. */}
          <span class={s.tileSub}>
            {report.secretsInFile === 0
              ? 'no provider or team credentials in this backup'
              : 're-encrypted with this gateway’s key'}
          </span>
        </div>
        <div class={s.tile}>
          <span class={s.tileLabel}>Passphrase</span>
          <span class={s.tileValue}>Accepted</span>
          <span class={s.tileSub}>the whole file was read and authenticated</span>
        </div>
      </div>

      {/* ── Findings, worst first ─────────────────────────────────────────── */}

      {report.collisions.length > 0 && (
        <section class={`${s.finding} ${s.warn}`}>
          <h4 class={s.findingHead}>
            <AlertTriangle size={15} />
            {exact(report.collisions.reduce((n, c) => n + c.count, 0))} rows would be skipped, not merged
          </h4>
          <p class={s.findingBody}>
            A merge never overwrites. Each of these carries a value that already belongs to a
            different row here, so the row on this gateway keeps what it has and the one in the
            backup is dropped. If the backup holds the version you want, restore with{' '}
            <strong>Replace everything</strong> instead.
          </p>
          <ul class={s.collisionList}>
            {report.collisions.map((c) => (
              <li key={`${c.model}.${c.column}`} class={s.collision}>
                <div class={s.collisionTop}>
                  <code class={s.collisionWhere}>{c.model}.{c.column}</code>
                  <Badge tone="yellow">{exact(c.count)} {c.count === 1 ? 'row' : 'rows'}</Badge>
                </div>
                {c.examples.length > 0 ? (
                  <div class={s.chips}>
                    {c.examples.map((v) => <code key={v} class={s.chip}>{v}</code>)}
                    {c.count > c.examples.length && (
                      <span class={s.chipMore}>+{exact(c.count - c.examples.length)} more</span>
                    )}
                  </div>
                ) : (
                  <p class={s.collisionHidden}>
                    This column holds hashed credentials, so the values are counted and never shown.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.missingEnv.length > 0 && (
        <section class={`${s.finding} ${s.warn}`}>
          <h4 class={s.findingHead}>
            <AlertTriangle size={15} />
            {report.missingEnv.length} {report.missingEnv.length === 1 ? 'setting is' : 'settings are'} missing from this server
          </h4>
          <p class={s.findingBody}>
            The gateway that wrote this backup had these set in its environment; this one does not.
            They live in <code>.env</code>, not in the database, so a backup cannot carry them. The
            data will restore correctly and whatever depends on these will be quietly dead until you
            set them and restart.
          </p>
          <div class={s.chips}>
            {report.missingEnv.map((name) => <code key={name} class={s.chip}>{name}</code>)}
          </div>
        </section>
      )}

      {report.schemaDrift.length > 0 && (
        <section class={`${s.finding} ${s.info}`}>
          <h4 class={s.findingHead}>
            <Info size={15} />
            This gateway’s schema has moved on since the backup, in ways it can absorb
          </h4>
          <p class={s.findingBody}>
            Nothing here stops the restore — anything that would have was refused before you got this
            far. These are the differences the restore will simply handle.
          </p>
          <ul class={s.driftList}>
            {report.schemaDrift.map((d, i) => (
              <li key={`${d.model}.${d.column ?? ''}.${i}`} class={s.drift}>
                <code class={s.driftWhere}>{d.model}{d.column ? `.${d.column}` : ''}</code>
                <Badge tone="blue">{DRIFT_LABEL[d.kind] ?? d.kind}</Badge>
                <span class={s.driftDetail}>{d.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {findings === 0 && (
        <section class={`${s.finding} ${s.ok}`}>
          <h4 class={s.findingHead}>
            <CheckCircle2 size={15} /> Nothing to flag
          </h4>
          <p class={s.findingBody}>
            The file opened, every row parsed, the schema matches this gateway and no row conflicts
            with one already here.
          </p>
        </section>
      )}

      {/* ── What pressing the button will actually do ─────────────────────── */}

      <section class={`${s.finding} ${report.mode === 'replace' ? s.danger : s.neutral}`}>
        <h4 class={s.findingHead}>
          {report.mode === 'replace' ? <AlertTriangle size={15} /> : <Info size={15} />}
          What happens when you restore
        </h4>
        {report.mode === 'replace' ? (
          <ul class={s.consequences}>
            <li>Every table is emptied first. Anything on this gateway that is not in the backup is gone.</li>
            <li>{exact(report.totalRowsInFile)} rows are loaded, and this gateway becomes the backup.</li>
            <li>
              <strong>Everyone is signed out, including you</strong> — sessions, rate-limit counters,
              circuit-breaker state and the response cache all describe a gateway that no longer exists.
            </li>
            <li>The gateway refuses API traffic while it works, telling callers how long to wait.</li>
            <li>It all happens in one transaction. If anything fails, nothing changes.</li>
          </ul>
        ) : (
          <ul class={s.consequences}>
            <li>Rows missing from this gateway are inserted. Up to {exact(report.totalRowsInFile)} of them.</li>
            <li>Nothing already here is overwritten, and nothing is removed.</li>
            <li>You stay signed in, and so does everyone else — a merge makes no existing data wrong.</li>
            <li>API traffic keeps flowing throughout.</li>
            <li>It all happens in one transaction. If anything fails, nothing changes.</li>
          </ul>
        )}
      </section>

      <details class={s.breakdown}>
        <summary class={s.breakdownHead}>Per-table row counts</summary>
        <table class={s.table}>
          <thead>
            <tr><th>Table</th><th class={s.num}>Rows in the file</th></tr>
          </thead>
          <tbody>
            {models.map(([model, n]) => (
              <tr key={model}><td><code>{model}</code></td><td class={s.num}>{exact(n)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
