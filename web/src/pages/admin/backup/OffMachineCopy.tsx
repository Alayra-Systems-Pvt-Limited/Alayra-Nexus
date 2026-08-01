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

import { TriangleAlert } from 'lucide-preact';
import { Field, Input, Toggle } from '../../../ui';
import type { BackupSchedule, BackupScheduleState } from '../../../api';
import s from './backup.module.css';

// The optional second copy, kept somewhere that is not this gateway.
//
// ── Why this is a toggle and not a destination picker ─────────────────────────────────────────
//
// The gateway always stores its own backups, so this is never a choice between two places to put
// them — it is "and also here". A picker would ask an operator to decide something they have no way
// to decide correctly, and the wrong answer produces a gateway that appears to be backing itself up
// and is not. That was the original design and it was wrong.
//
// So: off by default, nothing breaks if it is never touched, and the folder field only exists once
// somebody has said they want one.

interface Props {
  draft: BackupSchedule;
  update: (patch: Partial<BackupSchedule>) => void;
  /** Why the typed folder cannot be used, or null. Only shown while the copy is on. */
  folderIssue: string | null;
  state: BackupScheduleState | undefined;
}

export function OffMachineCopy({ draft, update, folderIssue, state }: Props) {
  return (
    <div class={s.copySection}>
      <Toggle
        checked={draft.copyOffMachine}
        onChange={(copyOffMachine) => update({ copyOffMachine })}
        label="Also keep a copy off this machine"
        hint="Backups are always stored in the gateway itself. This writes a second copy somewhere else, so they survive losing the database."
      />

      {draft.copyOffMachine && (
        <>
          <Field
            label="Folder on the gateway"
            hint="A full path on the server itself, not on this computer. The gateway creates it if it does not exist."
          >
            <Input
              value={draft.destination.path}
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              class={s.pathInput}
              placeholder="/var/backups/alayra-nexus"
              onInput={(e) => update({
                destination: { kind: 'directory', path: (e.target as HTMLInputElement).value },
              })}
            />
          </Field>
          {folderIssue && <p class={s.fieldProblem}>{folderIssue}</p>}

          {/* Reported here as well as in the notice at the top of the page, because this is where
              somebody is standing when they change the path — and a destination that stopped
              working is the one thing about this section worth interrupting for. */}
          {state?.lastCopyOutcome === 'failed' && (
            <p class={s.fieldProblem}>
              <TriangleAlert size={13} />{' '}
              The last copy did not reach it: {state.lastCopyError ?? 'the gateway did not say why.'}
              {' '}The backup itself was still taken and is in the list above.
            </p>
          )}
        </>
      )}
    </div>
  );
}
