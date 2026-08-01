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

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  CalendarClock, FolderOpen, ShieldAlert, Clock, History, Archive,
  CirclePlay, CircleCheckBig, TriangleAlert, RotateCcw, Trash2, Info,
} from 'lucide-preact';
import { Card, Button, Field, FieldBlock, Select, FormError, Toggle, Badge, Spinner } from '../../../ui';
import { GET, PUT, POST, type BackupSchedule, type BackupScheduleOverview, type BackupRunResult } from '../../../api';
import { bytes as formatBytes, relativeTime } from '../../../lib/format';
import {
  pathProblem, utcClock, utcInstantToday, localClock, localZone, localMoment,
  untilText, cadenceText, historyText, MAX_KEEP,
} from './scheduleText';
import { OffMachineCopy } from './OffMachineCopy';
import s from './backup.module.css';

// Scheduled backups (Phase B2) — the gateway taking one by itself.
//
// ── What this card has to make true ───────────────────────────────────────────────────────────
//
// A schedule is a promise about a thing that happens when nobody is watching, so the failure this
// screen exists to prevent is an operator who believes backups are running when they are not. Three
// specific ways that belief goes wrong, and what is done about each:
//
//  1. IT NEVER RAN. The card leads with the last run, not with the settings. A schedule that has
//     never fired says so in the same place a successful one reports its file.
//  2. IT FAILED, QUIETLY. A failed run is rendered as a refusal in the gateway's own words, in red,
//     above everything else — not as an absence of good news.
//  3. IT RAN, AND THE FILES CANNOT BE OPENED. Without a recovery key, an unattended backup is
//     readable only by the machine it is meant to survive. The server refuses to enable one; this
//     card refuses earlier and explains why, so the answer arrives before the disappointment.
//
// ── Why the form is a draft ───────────────────────────────────────────────────────────────────
//
// Every control edits local state and nothing reaches the gateway until Save. A schedule is four
// interdependent numbers and a path: saving each keystroke would mean a moment where "every 1 day"
// had become "every 1 day at 4:00 into a folder that does not exist yet", and the server would have
// to accept or refuse each of those halfway states. Draft-then-save also makes Revert possible, and
// is what lets "Back up now" state honestly that it uses the SAVED folder rather than the typed one.

/** Offered cadences. Not a free number: these are the ones an operator actually wants, named. */
const CADENCES = [1, 2, 3, 7, 14, 30];

/** Offered retention counts, with what each buys in time worked out alongside. */
const KEEPS = [3, 5, 7, 14, 30, 60, 90];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** Five-minute steps. A backup is not a cron job — nobody needs 04:07, and 12 choices beat 60. */
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/** Shown until the gateway answers, so the card never renders a schedule it has not been told. */
const BLANK: BackupSchedule = {
  enabled: false, everyDays: 1, hourUtc: 4, minuteUtc: 0, keep: 7,
  copyOffMachine: false,
  destination: { kind: 'directory', path: '' },
};

const same = (a: BackupSchedule, b: BackupSchedule): boolean =>
  a.enabled === b.enabled && a.everyDays === b.everyDays && a.hourUtc === b.hourUtc
  && a.minuteUtc === b.minuteUtc && a.keep === b.keep
  && a.copyOffMachine === b.copyOffMachine
  && a.destination.path === b.destination.path;

export function ScheduleCard({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [overview, setOverview] = useState<BackupScheduleOverview | null>(null);
  const [draft, setDraft] = useState<BackupSchedule>(BLANK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [ran, setRan] = useState<BackupRunResult | null>(null);

  // Re-read every half minute so "in 6h 12m" is never a number that stopped being true when the tab
  // was left open overnight. Deliberately not per second: nothing here is measured that finely.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const adopt = (next: BackupScheduleOverview) => {
    setOverview(next);
    setDraft(next.schedule);
  };

  useEffect(() => {
    GET<BackupScheduleOverview>('/admin/backup/schedule').then(
      (data) => { if (alive.current) { adopt(data); setLoading(false); } },
      (err: unknown) => {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : 'Could not read the backup schedule.');
        setLoading(false);
      },
    );
  }, [version]);

  const dirty = overview !== null && !same(draft, overview.schedule);
  const folderIssue = pathProblem(draft.destination.path);
  /**
   * Whether "Back up now" can do anything.
   *
   * It runs the SAVED schedule, not the draft, so it is judged against the saved folder — and it is
   * withdrawn rather than left to fail. A button that is always pressable and answers "choose a
   * folder" is a worse way to learn that than a button that says so before it is pressed, and a
   * gateway with no destination configured at all is the state a new install is in.
   */
  // "Back up now" can no longer be withheld for want of a destination: the gateway always has one.
  // The only reason left to hold it is an unsaved draft, because it runs the SAVED settings and
  // would otherwise copy to a folder the operator is no longer looking at.
  const runBlockedBy = dirty ? 'unsaved' : null;
  // Only the OFF-MACHINE copy needs a folder, and only once it is switched on. The schedule itself
  // is never blocked on configuration — that is the whole point of storing backups in the database.
  const blockingIssue = draft.copyOffMachine ? folderIssue : null;
  const noRecoveryKey = overview !== null && !overview.hasRecoveryKey;

  const update = (patch: Partial<BackupSchedule>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setJustSaved(false);
    setRan(null);
  };

  const save = async () => {
    if (saving || !dirty || blockingIssue) return;
    setSaving(true); setError(null); setRan(null);
    try {
      adopt(await PUT<BackupScheduleOverview>('/admin/backup/schedule', draft));
      setJustSaved(true);
      onChanged();
    } catch (err) {
      // The server's refusals here are already sentences meant for an operator — a missing recovery
      // key, a relative path — so they are shown verbatim rather than translated into something
      // vaguer. Only a transport failure gets wording of our own.
      setError(err instanceof Error ? err.message : 'The gateway would not take that schedule.');
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const runNow = async () => {
    if (running || runBlockedBy) return;
    setRunning(true); setError(null); setJustSaved(false); setRan(null);
    try {
      const result = await POST<BackupRunResult>('/admin/backup/schedule/run');
      adopt(result);
      setRan(result);
      // The new backup belongs in the list at the top of the page, which is a sibling component and
      // has no other way to learn it exists.
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The gateway could not write a backup.');
      // A failed run is RECORDED server-side — `lastRunAt` and `lastOutcome` are stamped whether it
      // worked or not. Without re-reading, the card would show a fresh red error immediately above
      // a state strip still reporting the previous run as the last thing that happened, which reads
      // as though the failure were somehow not counted.
      await GET<BackupScheduleOverview>('/admin/backup/schedule')
        .then((next) => { if (alive.current) adopt(next); })
        .catch(() => { /* the error above is the story; a stale strip is the lesser problem */ });
    } finally {
      if (alive.current) setRunning(false);
    }
  };

  // The UTC time being edited, rendered on the reader's own clock. A schedule stored in UTC that is
  // never shown in local time is how an operator ends up believing their backups run at breakfast.
  const preview = useMemo(
    () => utcInstantToday(draft.hourUtc, draft.minuteUtc, now),
    [draft.hourUtc, draft.minuteUtc, now],
  );
  const zone = localZone();

  const nextAt = overview?.nextRunAt ? new Date(overview.nextRunAt).getTime() : null;
  const state = overview?.state;

  return (
    <Card>
      <div class={s.cardHead}>
        <span class={s.cardIcon}><CalendarClock size={16} /></span>
        <div class={s.headMain}>
          <h3 class={s.cardTitle}>Automatic backups</h3>
          <p class={s.cardSub}>
            The gateway takes a backup on its own and keeps it in the list above — no folder to
            choose and nothing to mount, so this works the same on a laptop as on a hosted platform
            with no disk. It carries no passphrase, because nobody is here to type one, so it is
            opened with this gateway’s recovery key — which is why one has to exist first.
          </p>
        </div>
        {!loading && overview && (
          <StatusBadge enabled={overview.schedule.enabled} outcome={state?.lastOutcome ?? null} />
        )}
      </div>

      {loading && <div class={s.loadingRow}><Spinner /> <span>Reading the schedule…</span></div>}

      {error && <FormError>{error}</FormError>}

      {!loading && overview && (
        <>
          {/* The last run comes FIRST, above the settings. What an operator needs from this screen
              is almost never "what did I configure" — it is "did it work", and a failure buried
              under a form is a failure nobody reads. */}
          {state?.lastOutcome === 'failed' && (
            <div class={`${s.finding} ${s.danger} ${s.runNote}`} role="alert">
              <p class={s.findingHead}>
                <TriangleAlert size={15} />
                The last scheduled backup did not run
              </p>
              <p class={s.findingBody}>
                {state.lastError ?? 'The gateway did not say why.'}
                {' '}Tried {state.lastRunAt ? relativeTime(new Date(state.lastRunAt).toISOString(), now) : 'recently'}.
                The next run will be attempted at the usual time — older backups were left alone.
              </p>
            </div>
          )}

          {state?.lastOutcome === 'ok' && state.lastFilename && !ran?.ran && (
            <div class={s.doneNote} role="status">
              <CircleCheckBig size={15} />
              <span>
                Last backup <code>{state.lastFilename}</code>
                {state.lastRunAt && <> — {relativeTime(new Date(state.lastRunAt).toISOString(), now)}</>}
                {state.lastBytes !== null && <>, {formatBytes(state.lastBytes)}</>}
                {state.lastRows !== null && <>, {state.lastRows.toLocaleString()} rows</>}
                {state.lastPruned ? <>. {state.lastPruned} older {state.lastPruned === 1 ? 'backup' : 'backups'} removed to stay within the limit.</> : '.'}
              </span>
            </div>
          )}

          {ran?.ran && (
            <div class={s.doneNote} role="status">
              <Archive size={15} />
              <span>
                Stored as <code>{ran.filename}</code>
                {ran.bytes !== undefined && <> — {formatBytes(ran.bytes)}</>}
                {ran.rows !== undefined && <>, {ran.rows.toLocaleString()} rows</>}.
                It is in the list at the top of this page, ready to download. This also counts as
                the run for the current window, so the schedule will not take a second one tonight.
              </span>
            </div>
          )}

          {noRecoveryKey && (
            <div class={`${s.finding} ${s.warn} ${s.runNote}`}>
              <p class={s.findingHead}>
                <ShieldAlert size={15} />
                This gateway has no recovery key, so automatic backups cannot be switched on
              </p>
              <p class={s.findingBody}>
                An unattended backup carries no passphrase — nobody is present to type one — so the
                recovery key is the only thing that could ever open it. Without one these files
                could be read solely by this same server, which is the thing a backup exists to
                survive. The key is minted with the Recovery Kit when a gateway is claimed.
              </p>
            </div>
          )}

          <div class={s.scheduleForm}>
            <Toggle
              checked={draft.enabled}
              onChange={(enabled) => update({ enabled })}
              disabled={noRecoveryKey && !draft.enabled}
              label="Take a backup on a schedule"
              hint="The gateway checks once a minute whether a run is owed. A window missed because the server was off is caught up when it comes back, rather than skipped."
            />

            <div class={s.scheduleGrid}>
              <Field label="How often">
                <Select
                  value={String(draft.everyDays)}
                  onChange={(e) => update({ everyDays: Number((e.target as HTMLSelectElement).value) })}
                >
                  {CADENCES.map((d) => <option value={String(d)}>{cadenceText(d)}</option>)}
                </Select>
              </Field>

              {/* No hint on this label. It shares a row with two others, and a sentence long enough
                  to explain UTC wraps to three lines beside a two-line caption and shoves the row
                  out of shape. The line under the row carries the same point where there is space
                  for it — and carries the half that actually matters, which is what 04:00 is here. */}
              <FieldBlock label="At (UTC)">
                <div class={s.timeRow}>
                  <Select
                    aria-label="Hour, UTC"
                    value={String(draft.hourUtc)}
                    onChange={(e) => update({ hourUtc: Number((e.target as HTMLSelectElement).value) })}
                  >
                    {HOURS.map((h) => <option value={String(h)}>{String(h).padStart(2, '0')}</option>)}
                  </Select>
                  <span class={s.timeColon}>:</span>
                  <Select
                    aria-label="Minute, UTC"
                    value={String(draft.minuteUtc)}
                    onChange={(e) => update({ minuteUtc: Number((e.target as HTMLSelectElement).value) })}
                  >
                    {/* A stored value off the five-minute grid (set by hand, or by an older build)
                        would otherwise select nothing and silently reset itself on the next save. */}
                    {(MINUTES.includes(draft.minuteUtc) ? MINUTES : [...MINUTES, draft.minuteUtc].sort((a, b) => a - b))
                      .map((m) => <option value={String(m)}>{String(m).padStart(2, '0')}</option>)}
                  </Select>
                </div>
              </FieldBlock>

              <Field label="Keep">
                <Select
                  value={String(draft.keep)}
                  onChange={(e) => update({ keep: Number((e.target as HTMLSelectElement).value) })}
                >
                  {(KEEPS.includes(draft.keep) ? KEEPS : [...KEEPS, draft.keep].sort((a, b) => a - b))
                    .filter((k) => k <= MAX_KEEP)
                    .map((k) => <option value={String(k)}>{k} backups</option>)}
                </Select>
              </Field>
            </div>

            <p class={s.clockNote}>
              <Clock size={13} />
              <span>
                {utcClock(draft.hourUtc, draft.minuteUtc)} UTC is{' '}
                <strong>{localClock(preview)}</strong>
                {zone && <> where you are ({zone})</>}. Kept in UTC because a server’s local zone is
                whatever its image happened to be built with.
              </span>
            </p>


            {/* The settings read back as a sentence. Four numbers and a path do not tell an operator
                what they have chosen; "every day at 04:00, about a week of history" does. */}
            <p class={s.summary}>
              <Info size={13} />
              <span>
                {cadenceText(draft.everyDays)} at {utcClock(draft.hourUtc, draft.minuteUtc)} UTC,
                keeping the last {draft.keep} — {historyText(draft.everyDays, draft.keep)}.
                {draft.copyOffMachine && draft.destination.path.trim()
                  && <> A copy also goes to <code>{draft.destination.path.trim()}</code>.</>}
                {' '}Older backups are removed after a successful run; nothing the gateway did not
                write is ever touched.
              </span>
            </p>

            <OffMachineCopy
              draft={draft}
              update={update}
              folderIssue={folderIssue}
              state={overview.state}
            />

            <div class={s.actions}>
              <Button variant="primary" onClick={save} disabled={!dirty || saving || !!blockingIssue}>
                {saving ? 'Saving…' : 'Save schedule'}
              </Button>
              {dirty && !saving && (
                <Button variant="ghost" onClick={() => { setDraft(overview.schedule); setError(null); }}>
                  <RotateCcw size={13} /> Revert
                </Button>
              )}
              <span class={s.actionsSpacer} />
              <Button variant="secondary" onClick={runNow} disabled={running || !!runBlockedBy}>
                {running ? 'Taking a backup…' : <><CirclePlay size={14} /> Back up now</>}
              </Button>
            </div>

            {/* The text is wrapped in a single <span> on purpose. `.actionNote` is a flex row, so
                every raw text run and every <strong> would otherwise become its own flex ITEM and
                the sentence would lay itself out in columns — which is exactly what it did. */}
            {runBlockedBy === 'unsaved' && (
              <p class={s.actionNote}>
                <Info size={13} />
                <span>
                  “Back up now” uses the <strong>saved</strong> settings, not the ones typed above
                  — save first, or the copy would go somewhere you are no longer looking.
                </span>
              </p>
            )}
            {justSaved && !dirty && <p class={s.savedNote}>Saved.</p>}
          </div>

          <div class={s.runStrip}>
            <div class={s.runItem}>
              <span class={s.runLabel}><CalendarClock size={12} /> Next run</span>
              <span class={s.runValue}>
                {!overview.schedule.enabled || nextAt === null
                  ? <span class={s.runMuted}>Not scheduled</span>
                  : overview.dueNow
                    // A window already owed outranks the one after it. Switching the schedule on
                    // makes a backup due immediately, and the runner checks once a minute — a card
                    // that answered "tomorrow, 9:00 AM" here would be contradicted by a file
                    // appearing thirty seconds later.
                    ? <><strong>Due now</strong> <span class={s.runMuted}>· within a minute</span></>
                    : <>{untilText(nextAt - now)} <span class={s.runMuted}>· {localMoment(nextAt)}</span></>}
              </span>
            </div>
            <div class={s.runItem}>
              <span class={s.runLabel}><History size={12} /> Last run</span>
              <span class={s.runValue}>
                {state?.lastRunAt
                  ? <>{relativeTime(new Date(state.lastRunAt).toISOString(), now)} <span class={s.runMuted}>· {state.lastOutcome === 'ok' ? 'succeeded' : 'failed'}</span></>
                  : <span class={s.runMuted}>Never</span>}
              </span>
            </div>
            <div class={s.runItem}>
              <span class={s.runLabel}><FolderOpen size={12} /> Copy off machine</span>
              <span class={s.runValue}>
                {overview.schedule.copyOffMachine && overview.schedule.destination.path.trim()
                  ? <code class={s.runPath}>{overview.schedule.destination.path.trim()}</code>
                  : <span class={s.runMuted}>Off</span>}
              </span>
            </div>
            <div class={s.runItem}>
              <span class={s.runLabel}><Trash2 size={12} /> Retention</span>
              <span class={s.runValue}>
                {overview.schedule.keep} kept <span class={s.runMuted}>· {historyText(overview.schedule.everyDays, overview.schedule.keep)}</span>
              </span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * One word for the whole feature, in the header where it is read first.
 *
 * A failed last run outranks "on": a schedule that is switched on and not working is the state this
 * card exists to make impossible to miss, and a green badge above a red failure would be a lie told
 * by the more prominent of the two.
 */
function StatusBadge({ enabled, outcome }: { enabled: boolean; outcome: 'ok' | 'failed' | null }) {
  if (outcome === 'failed') return <Badge tone="red" dot>Failing</Badge>;
  if (!enabled) return <Badge tone="gray" dot>Off</Badge>;
  return <Badge tone="green" dot>On</Badge>;
}
