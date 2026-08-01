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
import { Database, HardDrive, ServerCog } from 'lucide-preact';
import { Card, Spinner, Badge, FormError } from '../../../ui';
import { GET, type MigrateStatus } from '../../../api';
import { MoveToPostgres } from './MoveToPostgres';
import s from './database.module.css';

// Where this gateway keeps its data, and how to move it (Phase S3).
//
// The screen exists because the machinery already worked and nobody could find it. A standalone
// gateway starts in seconds on a file, which is the whole reason people try it — and then the step
// that turns it into something a team can rely on was a paragraph in a document: set DATABASE_URL,
// restart, restore a backup. That is the moment somebody either commits to the product or gives up,
// and it was the one moment with no screen.
//
// A gateway already on Postgres sees this too, and is simply told so. Hiding the tab would leave an
// operator wondering where the option went; a sentence confirming they are past it is worth more.

export function DatabasePanel() {
  const [status, setStatus] = useState<MigrateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    GET<MigrateStatus>('/admin/migrate/status').then(
      (data) => { if (alive.current) setStatus(data); },
      (err: unknown) => {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : 'Could not read which database this gateway uses.');
      },
    );
  }, []);

  return (
    <div class={s.panel}>
      <Card>
        <div class={s.cardHead}>
          <span class={s.cardIcon}><Database size={16} /></span>
          <div class={s.headMain}>
            <h3 class={s.cardTitle}>Where this gateway keeps its data</h3>
            <p class={s.cardSub}>
              A gateway can run on a single file, which needs nothing set up and is how most people
              start, or on PostgreSQL, which is what a team and real traffic want. Moving between
              them is a supported step, not a reinstall.
            </p>
          </div>
          {status && (
            <Badge tone={status.engine === 'postgres' ? 'green' : 'gray'} dot>
              {status.engine === 'postgres' ? 'PostgreSQL' : 'Single file'}
            </Badge>
          )}
        </div>

        {error && <FormError>{error}</FormError>}
        {!status && !error && (
          <div class={s.loadingRow}><Spinner /> <span>Checking which database this gateway uses…</span></div>
        )}

        {status?.engine === 'postgres' && (
          <p class={s.settled}>
            <ServerCog size={15} />
            <span>
              This gateway already runs on PostgreSQL, so there is nothing to move. Its data lives
              in the database named by <code>DATABASE_URL</code>.
            </span>
          </p>
        )}

        {status?.canMigrate && (
          <>
            <p class={s.current}>
              <HardDrive size={15} />
              <span>
                Right now everything is in one file on this machine. That is durable as long as the
                machine is, and it does not survive a container being replaced — which is why moving
                to PostgreSQL is the step that makes a gateway something other people can depend on.
              </span>
            </p>
            <MoveToPostgres notMigrated={status.notMigrated} />
          </>
        )}
      </Card>
    </div>
  );
}
