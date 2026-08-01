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
import { Download, Trash2, CalendarClock, Hand } from 'lucide-preact';
import { Button, Spinner, FormError } from '../../../ui';
import { GET, DEL, getToken, type StoredBackup } from '../../../api';
import { bytes as formatBytes, relativeTime } from '../../../lib/format';
import s from './backup.module.css';

// The backups the gateway is holding, and the button that gets one onto the operator's own machine.
//
// This list is the reason the storage moved into the database at all. Before it, a scheduled backup
// could only be retrieved by somebody with access to the server's filesystem — which on Railway,
// Render or Fly is nobody, so the feature produced files that no human could ever reach.
//
// ── Why the download is not a plain <a href> ──────────────────────────────────────────────────
//
// The endpoint is owner-only and authenticated by a bearer token the app holds in memory. A browser
// navigation carries no Authorization header, so it would arrive unauthenticated and answer 401.
// The file is fetched with the header attached and handed to the browser as a blob instead.

export function BackupsList({ refreshToken }: { refreshToken: number }) {
  const [backups, setBackups] = useState<StoredBackup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Re-read whenever the parent says something happened — a backup was taken, one was deleted, the
  // schedule fired. `refreshToken` changing is the signal; its value is never used.
  useEffect(() => {
    let current = true;
    GET<{ backups: StoredBackup[] }>('/admin/backup/archive').then(
      (data) => { if (current && alive.current) setBackups(data.backups); },
      (err: unknown) => {
        if (!current || !alive.current) return;
        setError(err instanceof Error ? err.message : 'Could not read the stored backups.');
      },
    );
    return () => { current = false; };
  }, [refreshToken]);

  const download = async (name: string) => {
    setBusy(name); setError(null);
    try {
      const res = await fetch(`/admin/backup/archive/${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`The gateway would not release that backup (${res.status}).`);

      // Held only long enough to hand to the browser. The object URL is revoked immediately after
      // the click, or every download leaks the whole file for the life of the tab.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download did not start.');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const remove = async (name: string) => {
    setBusy(name); setError(null);
    try {
      await DEL(`/admin/backup/archive/${encodeURIComponent(name)}`);
      setBackups((list) => (list ?? []).filter((b) => b.filename !== name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The gateway would not delete that backup.');
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  if (backups === null && !error) {
    return <div class={s.loadingRow}><Spinner /> <span>Reading the stored backups…</span></div>;
  }

  const list = backups ?? [];

  return (
    <>
      {error && <FormError>{error}</FormError>}

      <div class={s.archiveHead}>
        <span class={s.archiveCount}>
          {list.length === 0 ? 'No backups yet' : `${list.length} ${list.length === 1 ? 'backup' : 'backups'}`}
        </span>
      </div>

      {list.length === 0 ? (
        <p class={s.archiveEmpty}>
          Nothing here yet. Switch the schedule on below, or press <strong>Back up now</strong> —
          either way the file lands in this list and can be downloaded straight from it.
        </p>
      ) : (
        <ul class={s.archiveList}>
          {list.map((b) => (
            <li key={b.filename} class={s.archiveRow}>
              <span class={s.archiveMain}>
                <span class={s.archiveName}>{b.filename}</span>
                <span class={s.archiveMeta}>
                  {b.origin === 'manual'
                    ? <><Hand size={11} /> Taken by hand</>
                    : <><CalendarClock size={11} /> On schedule</>}
                  {' · '}{relativeTime(b.createdAt)}
                  {' · '}{formatBytes(b.bytes)}
                  {' · '}{b.rows.toLocaleString()} rows
                </span>
              </span>
              <span class={s.archiveActions}>
                <Button
                  variant="secondary"
                  onClick={() => void download(b.filename)}
                  disabled={busy !== null}
                >
                  {busy === b.filename ? 'Working…' : <><Download size={13} /> Download</>}
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Delete ${b.filename}`}
                  onClick={() => void remove(b.filename)}
                  disabled={busy !== null}
                >
                  <Trash2 size={13} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
