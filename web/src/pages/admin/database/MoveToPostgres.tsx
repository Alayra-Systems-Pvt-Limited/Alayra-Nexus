/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Database, ServerCog, ShieldCheck, TriangleAlert, CircleCheckBig, Info, ArrowRight,
} from 'lucide-preact';
import { Button, Field, Input, FormError, Spinner } from '../../../ui';
import { POST, type MigrateTargetReport, type MigrateOutcome } from '../../../api';
import s from './database.module.css';

// Moving to PostgreSQL (Phase S3) — the screen the machinery has been waiting for.
//
// ── Why it is check-then-move and not one button ──────────────────────────────────────────────
//
// Everything that can be learned without touching the destination is learned first, and shown, and
// only then is the irreversible-feeling thing offered. The three questions an operator cannot
// answer by looking at a connection string are exactly the three the check answers: can it be
// reached, what is it, and is something already in it. Asking them costs one round trip and turns
// the move from an act of faith into a decision.
//
// ── Why the destination is never echoed back ──────────────────────────────────────────────────
//
// The string holds a database password. The server answers with `describes` — host and database
// name only — and every result on this screen renders THAT, never what was typed. The input keeps
// the value so the operator can correct a typo; nothing else on the page repeats it.
//
// ── Why the button says what it will not do ───────────────────────────────────────────────────
//
// The fear at this moment is "will I lose what I have". Nothing is deleted and nothing switches
// over — the gateway keeps running on its own file until the operator changes DATABASE_URL
// themselves. Saying so at the button is worth more than saying it in a paragraph nobody reads
// while deciding.

type Phase = 'idle' | 'checking' | 'checked' | 'moving' | 'done';

export function MoveToPostgres({ notMigrated }: { notMigrated: string[] }) {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<MigrateTargetReport | null>(null);
  const [outcome, setOutcome] = useState<MigrateOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every path here awaits a request that can outlive the tab being closed or the operator moving
  // to another panel mid-move; without this each one would set state on a component that is gone.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const check = async () => {
    setPhase('checking'); setError(null); setReport(null); setOutcome(null);
    try {
      const r = await POST<MigrateTargetReport>('/admin/migrate/inspect', { url });
      if (!alive.current) return;
      setReport(r);
      setPhase('checked');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The gateway could not reach that database.');
      setPhase('idle');
    }
  };

  const move = async () => {
    setPhase('moving'); setError(null);
    try {
      const r = await POST<MigrateOutcome>('/admin/migrate/run', { url });
      if (!alive.current) return;
      setOutcome(r);
      setPhase('done');
    } catch (err) {
      // A transport failure here is genuinely ambiguous — the move may have completed after the
      // connection dropped — so it must never be reported as "it did not happen".
      setError(
        err instanceof Error
          ? `${err.message} The move may still have finished; check the database before trying again.`
          : 'The connection dropped while moving. Check the database before trying again.',
      );
      setPhase('checked');
    }
  };

  const dirty = () => { setPhase('idle'); setReport(null); setOutcome(null); setError(null); };

  const usable = report?.reachable === true && report.occupied.length === 0;

  return (
    <div class={s.move}>
      {error && <FormError>{error}</FormError>}

      <Field
        label="PostgreSQL connection string"
        hint="From your database provider. It is used to move your data and is never saved, logged, or written to the audit trail."
      >
        <Input
          value={url}
          type="password"
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          class={s.urlInput}
          placeholder="postgresql://user:password@host:5432/nexus"
          disabled={phase === 'moving'}
          onInput={(e) => { setUrl((e.target as HTMLInputElement).value); dirty(); }}
        />
      </Field>

      {phase !== 'done' && (
        <div class={s.actions}>
          <Button
            variant={usable ? 'secondary' : 'primary'}
            onClick={() => void check()}
            disabled={url.trim().length === 0 || phase === 'checking' || phase === 'moving'}
          >
            {phase === 'checking' ? 'Checking…' : <><ServerCog size={14} /> Check this database</>}
          </Button>

          {usable && (
            <Button variant="primary" onClick={() => void move()} disabled={phase === 'moving'}>
              {phase === 'moving'
                ? 'Moving…'
                : <>Move my data <ArrowRight size={14} /></>}
            </Button>
          )}
        </div>
      )}

      {usable && phase === 'checked' && (
        <p class={s.reassure}>
          <Info size={13} />
          <span>
            Nothing is deleted and nothing switches over. This gateway keeps running on its own file
            until you change <code>DATABASE_URL</code> yourself.
          </span>
        </p>
      )}

      {phase === 'moving' && (
        <div class={s.working} role="status">
          <Spinner />
          <div>
            <p class={s.workingHead}>Moving your data. Do not close this page.</p>
            <p class={s.workingBody}>
              The gateway is refusing requests while this runs, so nothing can be written that would
              not arrive. It will answer normally again the moment this finishes, whether it worked
              or not.
            </p>
          </div>
        </div>
      )}

      {phase === 'checked' && report && <CheckResult report={report} />}
      {phase === 'done' && outcome && <Outcome outcome={outcome} notMigrated={notMigrated} />}
    </div>
  );
}

/** What the look at the destination found. */
function CheckResult({ report }: { report: MigrateTargetReport }) {
  if (!report.reachable) {
    return (
      <div class={`${s.finding} ${s.bad}`} role="alert">
        <p class={s.findingHead}><TriangleAlert size={15} /> That database could not be reached</p>
        <p class={s.findingBody}>{report.problem ?? 'The gateway did not say why.'}</p>
      </div>
    );
  }

  if (report.occupied.length > 0) {
    return (
      <div class={`${s.finding} ${s.bad}`} role="alert">
        <p class={s.findingHead}>
          <TriangleAlert size={15} />
          {report.describes} is already in use
        </p>
        <p class={s.findingBody}>
          It already holds Nexus data in {report.occupied.join(', ')}. Moving into it would put two
          gateways' records in one database, so this will not do it. Point this at a new, empty
          database instead — creating one is usually a single click with your provider.
        </p>
      </div>
    );
  }

  return (
    <div class={`${s.finding} ${s.good}`} role="status">
      <p class={s.findingHead}><ShieldCheck size={15} /> {report.describes} is ready</p>
      <p class={s.findingBody}>
        Reached it, and it holds no Nexus data.
        {report.version && <> It reports itself as <code>{report.version.split(' ').slice(0, 2).join(' ')}</code>.</>}
      </p>
    </div>
  );
}

/** What happened, and the one instruction that follows. */
function Outcome({ outcome, notMigrated }: { outcome: MigrateOutcome; notMigrated: string[] }) {
  if (!outcome.ok) {
    return (
      <div class={`${s.finding} ${s.bad}`} role="alert">
        <p class={s.findingHead}><TriangleAlert size={15} /> The move did not finish</p>
        <p class={s.findingBody}>{outcome.error ?? 'The gateway did not say why.'}</p>
        {outcome.mismatches && outcome.mismatches.length > 0 && (
          <ul class={s.mismatches}>
            {outcome.mismatches.map((m) => (
              <li key={m.model}>
                <code>{m.model}</code> — {m.source.toLocaleString()} here, {m.target.toLocaleString()} there
              </li>
            ))}
          </ul>
        )}
        {outcome.detail && <pre class={s.detail}>{outcome.detail}</pre>}
        <p class={s.findingBody}>
          <strong>This gateway is untouched and still running on its own file.</strong> Leave{' '}
          <code>DATABASE_URL</code> as it is.
        </p>
      </div>
    );
  }

  return (
    <div class={`${s.finding} ${s.good}`} role="status">
      <p class={s.findingHead}>
        <CircleCheckBig size={15} />
        {outcome.rowsCopied?.toLocaleString() ?? 0} rows are now in {outcome.target}
      </p>
      <p class={s.findingBody}>
        Every table was counted on both sides and they match. Not copied:{' '}
        {notMigrated.join(', ')} — your stored backups stay with this gateway, which has not been
        changed and can still be used or downloaded from.
      </p>
      <p class={s.next}>
        <Database size={14} />
        <span>
          <strong>To switch over:</strong> set <code>DATABASE_URL</code> to that database and start
          the gateway again. Until you do, you are still running on the old one — so there is no
          rush, and nothing breaks if you stop here.
        </span>
      </p>
    </div>
  );
}
