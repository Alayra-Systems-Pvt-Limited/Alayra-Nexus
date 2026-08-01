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
import { Archive } from 'lucide-preact';
import { Card, Spinner } from '../../../ui';
import { GET, type BackupScheduleOverview } from '../../../api';
import { bytes as formatBytes } from '../../../lib/format';
import { DataLossNotice } from './DataLossNotice';
import { BackupsList } from './BackupsList';
import s from './backup.module.css';

// "Your backups" — the first card on the page, and the one that needed no configuration to work.
//
// It is first because it is the answer to the only question an operator actually arrives with: is
// there a backup, and can I have it. The schedule below decides when the next one happens; this is
// the evidence that the last one did.

export function StoredBackupsCard({ version }: { version: number }) {
  const [overview, setOverview] = useState<BackupScheduleOverview | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Re-read alongside the list whenever the panel says something changed, so the notice below can
  // never claim "no copy is configured" one render after the schedule card saved one.
  useEffect(() => {
    let current = true;
    GET<BackupScheduleOverview>('/admin/backup/schedule')
      .then((data) => { if (current && alive.current) setOverview(data); })
      .catch(() => { /* the list reports its own failure; a missing notice is the lesser harm */ });
    return () => { current = false; };
  }, [version]);

  return (
    <Card>
      <div class={s.cardHead}>
        <span class={s.cardIcon}><Archive size={16} /></span>
        <div class={s.headMain}>
          <h3 class={s.cardTitle}>Your backups</h3>
          <p class={s.cardSub}>
            Every backup the gateway has taken, kept inside its own database so it works the same on
            a laptop, a server, or a hosted platform with no disk of its own. Nothing to set up —
            press download and the file is yours.
          </p>
        </div>
        {overview && overview.storedBytes > 0 && (
          <span class={s.archiveCount}>{formatBytes(overview.storedBytes)} stored</span>
        )}
      </div>

      {overview
        ? <DataLossNotice overview={overview} />
        : <div class={s.loadingRow}><Spinner /> <span>Checking where your backups are kept…</span></div>}

      <BackupsList refreshToken={version} />
    </Card>
  );
}
