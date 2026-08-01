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

import { TriangleAlert, ShieldCheck, HardDriveDownload } from 'lucide-preact';
import type { BackupScheduleOverview } from '../../../api';
import s from './backup.module.css';

// The one irreversible fact in this panel, stated at whatever strength is currently true.
//
// ── Why this is three states and not a banner ─────────────────────────────────────────────────
//
// Backups live in the database they protect. That is what makes them work on any host with no
// setup, and it is the one thing they cannot survive — so an operator who has done nothing needs to
// be told plainly, in red, that these files must be taken off the machine.
//
// But a permanent red box is how people are trained to stop seeing red. Someone who configured an
// off-machine copy and whose copy is working has done the thing the box was asking for, and leaving
// the alarm at full strength would teach them the colour means nothing — including on the day it
// means something. So the warning DE-ESCALATES as the risk actually falls.
//
// ── Why a folder does not clear it ────────────────────────────────────────────────────────────
//
// A folder is durable on a VM and wiped on every redeploy inside a container, and the gateway
// cannot tell which of those it is running in. "A folder is configured" therefore proves that
// somebody typed a path, not that the backups are safe. Hiding a true warning on a signal that
// proves nothing is exactly the failure this box exists to prevent — so a working folder copy earns
// amber, not silence. Only object storage, which is a different machine by definition, clears it.
//
// ── Why the state keys on the last copy, not on the configuration ─────────────────────────────
//
// A destination that is configured but failing is WORSE than none: the operator believes they are
// covered. A copy that has never run cannot be evidence either. So only a copy that actually
// succeeded moves the state down.

type Level = 'exposed' | 'copy-failing' | 'on-machine' | 'off-machine';

function level(overview: BackupScheduleOverview): Level {
  const { schedule, state } = overview;
  if (!schedule.copyOffMachine) return 'exposed';
  if (state.lastCopyOutcome === 'failed') return 'copy-failing';
  // Never run yet counts as on-machine rather than off: nothing has been proven, and the amber
  // wording below is careful to say "will be" rather than claiming a copy exists.
  if (schedule.destination.kind === 'directory') return 'on-machine';
  return 'off-machine';
}

export function DataLossNotice({ overview }: { overview: BackupScheduleOverview }) {
  const kind = level(overview);
  const { state } = overview;
  const where = state.lastCopyDestination ?? overview.schedule.destination.path.trim();

  if (kind === 'off-machine') {
    return (
      <p class={s.safeNote} role="status">
        <ShieldCheck size={14} />
        <span>
          A copy of every backup is written to <code>{where}</code>, which is not this machine — so
          these survive losing the gateway and its database entirely.
        </span>
      </p>
    );
  }

  if (kind === 'copy-failing') {
    return (
      <div class={s.dataLoss} role="alert">
        <p class={s.dataLossHead}>
          <TriangleAlert size={16} />
          The copy that was meant to leave this machine is not being written
        </p>
        <p class={s.dataLossBody}>
          {state.lastCopyError ?? 'The gateway did not say why.'} Until that is fixed, every backup
          exists in one place only — inside the database it protects. The backups themselves were
          taken and can still be downloaded below; it is the second copy that is missing, which is
          the one that was going to survive losing this server.
        </p>
        <p class={s.dataLossBody}>
          Download the newest one now, then fix the destination.
        </p>
      </div>
    );
  }

  if (kind === 'on-machine') {
    return (
      <div class={s.onMachine} role="note">
        <p class={s.onMachineHead}>
          <HardDriveDownload size={15} />
          A second copy is being written to <code>{where}</code>
        </p>
        <p class={s.onMachineBody}>
          That copy is only as safe as the machine it sits on. If this gateway runs on a VM or your
          own hardware, you are covered for the case that matters — losing the database. If it runs
          in a container without a mounted volume, that folder is erased on the next deploy and you
          are not covered. The gateway cannot tell which of those is true from in here, so it is
          worth confirming once.
        </p>
      </div>
    );
  }

  return (
    <div class={s.dataLoss} role="alert">
      <p class={s.dataLossHead}>
        <TriangleAlert size={16} />
        Download these. They live inside the database they protect.
      </p>
      <p class={s.dataLossBody}>
        Storing backups in the gateway itself is what makes them work on any host with no setup —
        and it is the one thing they cannot survive. A backup in this list will carry you through a
        redeploy, a failed upgrade, a table emptied by mistake, or a move to a new machine. It will
        not carry you through losing the database. If that goes, every backup here goes in the same
        moment — there is no second copy on our side, and no support request can rebuild one.
      </p>
      <p class={s.dataLossBody}>
        Take the newest file down whenever one is written, or switch on{' '}
        <strong>Keep a copy off this machine</strong> below and stop having to remember.
      </p>
    </div>
  );
}
