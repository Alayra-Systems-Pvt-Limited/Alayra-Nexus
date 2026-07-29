import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  Upload, FileCheck2, ShieldAlert, Search, RotateCcw, Merge, Replace, XCircle, Radio,
} from 'lucide-preact';
import { Card, Button, Field, PasswordInput, Input, FormError, Badge } from '../../../ui';
import type { MaintenanceView, RestoreMode, RestoreReport } from '../../../api';
import { readMaintenance, restoreBackup, RestoreError, type RestoreHandle } from '../../../lib/backupClient';
import { bytes } from '../../../lib/format';
import { DryRunReport } from './DryRunReport';
import { RestoreProgress } from './RestoreProgress';
import { RestoreOutcome } from './RestoreOutcome';
import s from './backup.module.css';

// Restoring, as a wizard that cannot be rushed (Phase B1.4).
//
// ── Why the check is not optional ─────────────────────────────────────────────────────────────
//
// The dry run reads and authenticates the entire file and writes nothing, which means every question
// worth asking has an answer BEFORE anything is touched: is the passphrase right, is the file whole,
// does the schema still fit, which rows would be dropped, which settings are missing. A "restore
// now" button that skipped it would be offering a decision with none of that on screen. So there is
// no such button — the only route to a restore runs through its own report.
//
// ── Why editing anything throws the report away ───────────────────────────────────────────────
//
// A report describes one file, one passphrase and one mode. Change any of them and it describes
// something that is no longer being proposed. Keeping it on screen would be the worst kind of lie:
// accurate numbers about the wrong operation.

const PHRASE = 'REPLACE ALL DATA';
const MIN_PASSPHRASE = 12;

/** How often to ask the gateway how far it has got. Progress is published at most once a second. */
const POLL_MS = 1_500;

type Stage = 'choose' | 'checked' | 'running' | 'done';

export function RestoreWizard({ targetEngine }: { targetEngine?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [master, setMaster] = useState('');
  const [typed, setTyped] = useState('');

  const [stage, setStage] = useState<Stage>('choose');
  const [plan, setPlan] = useState<RestoreReport | null>(null);
  const [outcome, setOutcome] = useState<RestoreReport | null>(null);
  const [error, setError] = useState<RestoreError | null>(null);
  const [dragging, setDragging] = useState(false);

  // In-flight state. `dryRun` is held here rather than derived, because what is running has to stay
  // true to what was STARTED even if the operator's selection changes underneath it.
  const [running, setRunning] = useState<{ dryRun: boolean; mode: RestoreMode; size: number } | null>(null);
  const [phase, setPhase] = useState<'uploading' | 'working'>('uploading');
  const [uploaded, setUploaded] = useState(0);
  const [maintenance, setMaintenance] = useState<MaintenanceView | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** A restore someone else started, or one this tab was reloaded away from. We can watch, not report. */
  const [adopted, setAdopted] = useState(false);

  const handle = useRef<RestoreHandle | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /** Any edit invalidates a report that was about the previous selection. */
  const invalidate = useCallback(() => {
    setPlan(null); setError(null);
    setStage((current) => (current === 'checked' ? 'choose' : current));
  }, []);

  const chooseFile = (next: File | null) => { setFile(next); invalidate(); };

  // ── Adopt a restore already in flight ───────────────────────────────────
  //
  // A reload during a restore, or a second owner watching from their own browser, must not be shown
  // an inviting "choose a file" form while the gateway is mid-transaction. Asked once on mount; the
  // watcher below takes over from there.
  useEffect(() => {
    let alive = true;
    void readMaintenance().then((status) => {
      if (!alive || !status?.active || !status.maintenance) return;
      setAdopted(true);
      setRunning({ dryRun: false, mode: 'replace', size: 0 });
      setMaintenance(status.maintenance);
      setPhase('working');
      setStage('running');
    });
    return () => { alive = false; };
  }, []);

  // ── Watch the gateway's own progress ────────────────────────────────────
  //
  // Only for a `replace`, because that is the only operation the gateway publishes progress for —
  // the flag carrying it is the same one that refuses API traffic, and a merge has no business
  // taking the gateway offline. Polling during a merge would ask a question with a known answer.
  const watching = stage === 'running' && phase === 'working' && !!running && !running.dryRun && running.mode === 'replace';
  useEffect(() => {
    if (!watching) return;
    let alive = true;
    const tick = async () => {
      const status = await readMaintenance();
      if (!alive) return;
      if (status?.active && status.maintenance) { setMaintenance(status.maintenance); return; }
      // The flag is down. For a restore we started, the request's own answer is the truth and it is
      // already on its way — do nothing and let it arrive. For an adopted one there is no answer
      // coming, so this is the end of what we can honestly say.
      if (adopted) { setAdopted(false); setStage('done'); }
    };
    const id = window.setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    return () => { alive = false; window.clearInterval(id); };
  }, [watching, adopted]);

  // Elapsed time for the phases with no percentage to show.
  useEffect(() => {
    if (stage !== 'running' || phase !== 'working') return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [stage, phase]);

  const start = async (dryRun: boolean) => {
    if (!file || stage === 'running') return;
    setError(null);
    setUploaded(0);
    setMaintenance(null);
    setPhase('uploading');
    setRunning({ dryRun, mode, size: file.size });
    setStage('running');

    const started = restoreBackup(
      {
        file,
        passphrase: passphrase || undefined,
        mode,
        dryRun,
        ...(dryRun ? {} : { masterPassword: master || undefined, confirm: typed || undefined }),
        ...(dryRun ? {} : { expectedRows: plan?.totalRowsInFile }),
      },
      (fraction) => {
        setUploaded(fraction);
        if (fraction >= 1) setPhase('working');
      },
    );
    handle.current = started;

    try {
      const report = await started.done;
      if (dryRun) { setPlan(report); setStage('checked'); }
      else { setOutcome(report); setStage('done'); }
    } catch (err) {
      setError(err instanceof RestoreError ? err : new RestoreError(0, 'The restore failed.'));
      setStage(dryRun ? 'choose' : 'checked');
    } finally {
      handle.current = null;
      setRunning(null);
    }
  };

  const startOver = () => {
    setFile(null); setPassphrase(''); setMaster(''); setTyped('');
    setPlan(null); setOutcome(null); setError(null); setStage('choose');
  };

  const passphraseTooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const canCheck = !!file && !passphraseTooShort;
  const replaceReady = mode !== 'replace' || (typed === PHRASE && master.length > 0);

  // ── Screens ─────────────────────────────────────────────────────────────

  if (stage === 'running' && running) {
    return (
      <Card>
        <WizardHead stage={stage} />
        {adopted && (
          <div class={s.adopted} role="status">
            <Radio size={15} /> A restore is already running on this gateway. This is a view of it,
            not one this tab started — the report will belong to whoever began it.
          </div>
        )}
        <RestoreProgress
          phase={phase}
          uploadFraction={uploaded}
          fileSize={running.size}
          maintenance={maintenance}
          elapsedSeconds={elapsed}
          dryRun={running.dryRun}
          mode={running.mode}
          onAbort={phase === 'uploading' ? () => handle.current?.abort() : undefined}
        />
      </Card>
    );
  }

  if (stage === 'done') {
    return (
      <Card>
        <WizardHead stage={stage} />
        {outcome
          ? <RestoreOutcome report={outcome} onStartOver={startOver} />
          : (
            <div class={s.adopted} role="status">
              <FileCheck2 size={15} /> The restore that was running has finished. This tab did not
              start it, so there is no report to show here — reload to see the gateway as it now is.
            </div>
          )}
      </Card>
    );
  }

  return (
    <Card>
      <WizardHead stage={stage} />

      {error && <RefusalNote error={error} />}

      {/* ── The file ──────────────────────────────────────────────────── */}
      {file ? (
        <div class={s.picked}>
          <span class={s.pickedIcon}><FileCheck2 size={16} /></span>
          <div class={s.pickedText}>
            <span class={s.pickedName}>{file.name}</span>
            <span class={s.pickedSize}>{bytes(file.size)}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => chooseFile(null)}>Choose a different file</Button>
        </div>
      ) : (
        <div
          class={`${s.drop} ${dragging ? s.dropOver : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragging(false);
            const dropped = e.dataTransfer?.files?.[0];
            if (dropped) chooseFile(dropped);
          }}
        >
          <Upload size={22} class={s.dropIcon} />
          <p class={s.dropTitle}>Drop a backup file here</p>
          <p class={s.dropSub}>or</p>
          {/* A real file input, triggered by a real button — the drop zone is the convenience, never
              the only route. A keyboard user reaches this button in the normal tab order. */}
          <Button size="sm" onClick={() => fileInput.current?.click()}>Browse for a backup</Button>
          <input
            ref={fileInput}
            type="file"
            accept=".nxb"
            class={s.hiddenInput}
            onChange={(e) => chooseFile((e.target as HTMLInputElement).files?.[0] ?? null)}
          />
        </div>
      )}

      {/* ── Passphrase and mode ───────────────────────────────────────── */}
      <div class={s.restoreForm}>
        <Field
          label="Backup passphrase"
          hint="The passphrase this file was written with. Leave empty only for a file this same gateway wrote for itself."
        >
          <PasswordInput
            value={passphrase}
            autoComplete="off"
            placeholder="The passphrase for this file"
            onInput={(e) => { setPassphrase((e.target as HTMLInputElement).value); invalidate(); }}
          />
        </Field>
        {passphraseTooShort && (
          <p class={s.fieldProblem}>A backup passphrase is at least {MIN_PASSPHRASE} characters, so this one cannot be right.</p>
        )}

        <fieldset class={s.modes}>
          <legend class={s.modesLegend}>How should the backup be applied?</legend>
          <ModeOption
            id="merge"
            active={mode === 'merge'}
            onPick={() => { setMode('merge'); invalidate(); }}
            icon={<Merge size={16} />}
            title="Merge"
            badge={<Badge tone="green">Safe</Badge>}
            body="Insert only what is missing here. Nothing on this gateway is overwritten or removed, and nobody is signed out."
          />
          <ModeOption
            id="replace"
            active={mode === 'replace'}
            onPick={() => { setMode('replace'); invalidate(); }}
            icon={<Replace size={16} />}
            title="Replace everything"
            badge={<Badge tone="red">Destructive</Badge>}
            body="Empty every table first, then load the backup. This gateway becomes the backup, and everyone is signed out — including you."
          />
        </fieldset>
      </div>

      {/* ── The check, and only then the restore ──────────────────────── */}
      {stage === 'checked' && plan ? (
        <>
          <DryRunReport report={plan} targetEngine={targetEngine} />

          {mode === 'replace' && (
            <div class={s.confirmBlock}>
              <p class={s.confirmLead}>
                <ShieldAlert size={15} /> Two proofs, the same two the factory reset asks for: the
                password this gateway was installed with, and the phrase typed out in full.
              </p>
              <Field
                label="Administrator master password"
                hint="ADMIN_PASSWORD from the server's environment."
              >
                <PasswordInput
                  value={master}
                  autoComplete="off"
                  onInput={(e) => setMaster((e.target as HTMLInputElement).value)}
                />
              </Field>
              <Field label={`Type ${PHRASE} to confirm`}>
                <Input
                  type="text"
                  value={typed}
                  autoComplete="off"
                  placeholder={PHRASE}
                  onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
                />
              </Field>
            </div>
          )}

          <div class={s.actions}>
            <Button
              variant={mode === 'replace' ? 'danger' : 'primary'}
              onClick={() => void start(false)}
              disabled={!replaceReady}
            >
              {mode === 'replace' ? 'Replace everything with this backup' : 'Merge this backup in'}
            </Button>
            <Button variant="ghost" onClick={startOver}><RotateCcw size={14} /> Start over</Button>
          </div>
          <p class={s.uploadTwice}>
            The file uploads a second time — the check keeps nothing on the gateway, by design.
          </p>
        </>
      ) : (
        <div class={s.actions}>
          <Button variant="primary" onClick={() => void start(true)} disabled={!canCheck}>
            <Search size={14} /> Check this backup
          </Button>
          <span class={s.actionNote}>
            Reads and authenticates the whole file and writes nothing. You will see exactly what a
            restore would do before anything is touched.
          </span>
        </div>
      )}
    </Card>
  );
}

/** The three steps, and which one is live. Present from the first screen so the shape is never a surprise. */
function WizardHead({ stage }: { stage: Stage }) {
  const at = stage === 'choose' ? 0 : stage === 'checked' ? 1 : 2;
  const steps = ['Choose the file', 'Read the report', 'Restore'];
  return (
    <div class={s.cardHead}>
      <span class={s.cardIcon}><Upload size={16} /></span>
      <div class={s.headMain}>
        <h3 class={s.cardTitle}>Restore from a backup</h3>
        <ol class={s.steps}>
          {steps.map((label, i) => (
            <li key={label} class={`${s.step} ${i === at ? s.stepOn : ''} ${i < at ? s.stepDone : ''}`}>
              <span class={s.stepDot}>{i + 1}</span>
              <span class={s.stepLabel}>{label}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ModeOption({ id, active, onPick, icon, title, badge, body }: {
  id: string; active: boolean; onPick: () => void;
  icon: preact.JSX.Element; title: string; badge: preact.JSX.Element; body: string;
}) {
  return (
    <label class={`${s.mode} ${active ? s.modeOn : ''} ${id === 'replace' ? s.modeDanger : ''}`}>
      <input
        type="radio"
        name="restore-mode"
        class={s.modeRadio}
        checked={active}
        onChange={onPick}
      />
      <span class={s.modeTop}>
        <span class={s.modeIcon}>{icon}</span>
        <span class={s.modeTitle}>{title}</span>
        {badge}
      </span>
      <span class={s.modeBody}>{body}</span>
    </label>
  );
}

/**
 * A refusal, with the gateway's own next step.
 *
 * Three outcomes reach here and they are NOT the same, which is the whole reason the server bothers
 * to distinguish them: a wrong passphrase or a damaged file, a restore that ran out of time (the
 * file is fine — raise the timeout), and a schema this gateway has moved past (the file is fine —
 * it needs a gateway of the matching version). Telling an operator their backup "may be damaged"
 * when it is not is how a good backup gets thrown away.
 */
function RefusalNote({ error }: { error: RestoreError }) {
  const blocking = (error.schemaDrift ?? []).filter((d) => d.blocking);
  return (
    <div class={s.refusal} role="alert">
      <FormError>{error.message}</FormError>
      {error.hint && <p class={s.refusalHint}><XCircle size={13} /> {error.hint}</p>}
      {blocking.length > 0 && (
        <ul class={s.driftList}>
          {blocking.map((d, i) => (
            <li key={`${d.model}.${d.column ?? ''}.${i}`} class={s.drift}>
              <code class={s.driftWhere}>{d.model}{d.column ? `.${d.column}` : ''}</code>
              <Badge tone="red">blocks</Badge>
              <span class={s.driftDetail}>{d.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
