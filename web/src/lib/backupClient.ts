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

// The transport for backup, restore and the maintenance poll (Phase B1.4).
//
// Everything else the dashboard asks of the gateway goes through `api()`. These three cannot, and
// each for a different reason:
//
//  1. An EXPORT answers with an octet stream, not JSON. `api()` ends in `res.json()`.
//  2. A RESTORE is a multipart upload of a file with no upper bound. `fetch` cannot report upload
//     progress — the spec has no hook for it — so a 900 MB restore would sit silent for minutes with
//     no way to tell "uploading" from "hung". XMLHttpRequest still reports it, so that is what this
//     uses. Not legacy code: the only API in the platform that answers the question.
//  3. The MAINTENANCE POLL must survive its own subject. A `replace` restore wipes every session
//     from the key-value store the moment it commits, so the very next poll answers 401 — and
//     `api()` treats a 401 as "your session expired", clears the token and throws the operator back
//     to the sign-in screen. Mid-restore that would tear the progress view off the screen just
//     before it could show the result. So this one poll reads the response itself and reports
//     "no answer" rather than "sign out".

import { getToken, type MaintenanceStatus, type RestoreMode, type RestoreReport, type SchemaDifference } from '../api';

/** Server default; only ever used to name the file if the gateway sends no disposition header. */
const FALLBACK_FILENAME = 'alayra-nexus-backup.nxb';

/**
 * A refusal the restore route can explain in structured terms.
 *
 * `schemaDrift` arrives on the one refusal that is neither a bad file nor a bad passphrase: the
 * backup is intact and this gateway's schema has moved past it (C4). It carries the exact list of
 * differences, which is far more use to an operator than the sentence alone.
 */
export class RestoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The gateway's own next step, when it has one. Always "nothing was changed" plus a remedy. */
    readonly hint?: string,
    readonly schemaDrift?: SchemaDifference[],
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** Pull the human sentence out of a gateway error body, whether ours or Fastify's. */
function errorFrom(body: string, status: number): RestoreError {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown; message?: unknown; statusCode?: unknown;
      hint?: unknown; schemaDrift?: unknown;
    };
    const order = typeof parsed.statusCode === 'number' ? [parsed.message, parsed.error] : [parsed.error, parsed.message];
    const sentence = order.find((f): f is string => typeof f === 'string' && f.trim().length > 0);
    return new RestoreError(
      status,
      sentence ?? `HTTP ${status}`,
      typeof parsed.hint === 'string' ? parsed.hint : undefined,
      Array.isArray(parsed.schemaDrift) ? (parsed.schemaDrift as SchemaDifference[]) : undefined,
    );
  } catch {
    return new RestoreError(status, body.trim() || `HTTP ${status}`);
  }
}

/** `attachment; filename="nexus-backup-….nxb"` → the filename, or null if the header says nothing. */
export function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(disposition);
  if (quoted) return quoted[1];
  const bare = /filename\s*=\s*([^;]+)/i.exec(disposition);
  return bare ? bare[1].trim() : null;
}

/**
 * Download an encrypted backup of this gateway.
 *
 * The whole response is held by the browser before the save dialog opens, which is unavoidable: a
 * download that carries a passphrase must be a POST, and only a link can stream straight to disk.
 * Deliberately NOT read chunk-by-chunk to show a byte counter — that would pin every byte in the
 * tab's JavaScript heap, where a large backup is an out-of-memory crash, while `blob()` lets the
 * browser spill to disk. An honest elapsed time is worth less than not crashing on a real backup.
 *
 * If the stream breaks part-way the gateway destroys the connection, `blob()` rejects, and no file
 * is saved at all. That is the point: a truncated backup will not authenticate on restore, and an
 * operator must never be left holding one that looks complete.
 */
export async function downloadBackup(passphrase: string, includeGatewayRecipient: boolean): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/admin/backup/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase, includeGatewayRecipient }),
    });
  } catch {
    throw new RestoreError(0, 'Could not reach the gateway.');
  }

  if (!res.ok) throw errorFrom(await res.text().catch(() => ''), res.status);

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw new RestoreError(
      0,
      'The download was cut short, so the backup is incomplete.',
      'Nothing was saved. A partial backup cannot be restored — take another one.',
    );
  }

  const filename = filenameFrom(res.headers.get('content-disposition')) ?? FALLBACK_FILENAME;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick — revoking synchronously cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}

export interface RestoreInput {
  file: File;
  /** Omitted only for a file this gateway wrote for itself, which it can open with its own key. */
  passphrase?: string;
  mode: RestoreMode;
  dryRun: boolean;
  /** `replace` alone, and only for real. A dry run writes nothing, so it is asked for no proof. */
  masterPassword?: string;
  confirm?: string;
  /**
   * What the dry run counted, so the progress bar has a denominator.
   *
   * A backup states its row count in the TRAILER, at the end of the file, so a restore cannot know
   * its own total until it has finished. Untrusted and cosmetic on the server: a wrong value
   * misdraws a bar and changes nothing about what is written.
   */
  expectedRows?: number;
}

export interface RestoreHandle {
  done: Promise<RestoreReport>;
  /**
   * Stop the upload.
   *
   * Honest only while bytes are still going up: the gateway does not begin reading the backup until
   * the last part has arrived, so an aborted upload is a restore that never started. Once the upload
   * completes there is nothing here that can stop the work — the caller must withdraw the control
   * rather than offer one that quietly does nothing.
   */
  abort: () => void;
}

/**
 * Upload a backup and restore from it — or, with `dryRun`, read it and write nothing.
 *
 * `onUpload` receives 0…1 as the file goes up. Once it reaches 1 the gateway is working and the
 * caller should switch to polling `readMaintenance` for the other half of the story.
 */
export function restoreBackup(input: RestoreInput, onUpload?: (fraction: number) => void): RestoreHandle {
  const form = new FormData();
  // `file` last would be equally valid, but the gateway reads parts in order and spools the file to
  // disk as it arrives; putting the small fields first means they are parsed before a long upload.
  if (input.passphrase !== undefined) form.append('passphrase', input.passphrase);
  form.append('mode', input.mode);
  form.append('dryRun', String(input.dryRun));
  if (input.masterPassword !== undefined) form.append('masterPassword', input.masterPassword);
  if (input.confirm !== undefined) form.append('confirm', input.confirm);
  // Only when positive. The route parses this with `z.coerce.number().int().positive()`, so a zero —
  // which is exactly what an empty backup's dry run reports — would fail validation and turn a
  // cosmetic hint into a 400 on the real restore.
  if (input.expectedRows !== undefined && input.expectedRows > 0) {
    form.append('expectedRows', String(input.expectedRows));
  }
  form.append('file', input.file, input.file.name);

  const xhr = new XMLHttpRequest();
  const done = new Promise<RestoreReport>((resolve, reject) => {
    xhr.open('POST', '/admin/backup/restore');
    xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    // Content-Type is deliberately NOT set: the browser has to write it itself so it can include the
    // multipart boundary. Setting it by hand produces a header with no boundary and a body the
    // gateway cannot parse — a 400 that looks like a bad file.

    xhr.upload.onprogress = (e) => {
      if (onUpload && e.lengthComputable && e.total > 0) onUpload(Math.min(1, e.loaded / e.total));
    };
    // `load` on the upload fires when the last byte is out, which is the moment the story moves from
    // "uploading" to "the gateway is working". Reported explicitly so a caller never has to infer it
    // from a progress event that may round to 0.999.
    xhr.upload.onload = () => onUpload?.(1);

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as RestoreReport);
        } catch {
          reject(new RestoreError(xhr.status, 'The gateway answered with something this dashboard could not read.'));
        }
        return;
      }
      reject(errorFrom(xhr.responseText, xhr.status));
    };
    xhr.onerror = () => reject(new RestoreError(0, 'Could not reach the gateway.'));
    xhr.onabort = () => reject(new RestoreError(0, 'The upload was stopped. Nothing was changed.'));
    xhr.send(form);
  });

  return { done, abort: () => xhr.abort() };
}

/**
 * Is a restore running, and how far in?
 *
 * Never throws and never signs anyone out. Any failure — the network, a 401 from the session this
 * very restore just invalidated, an unreadable body — answers `null`, meaning "no answer this time".
 * A watcher that could destroy the thing it watches would be worse than no watcher.
 */
export async function readMaintenance(): Promise<MaintenanceStatus | null> {
  try {
    const res = await fetch('/admin/backup/maintenance', {
      headers: { Authorization: `Bearer ${getToken()}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as MaintenanceStatus;
  } catch {
    return null;
  }
}
