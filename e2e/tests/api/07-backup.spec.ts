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

import { test, expect } from '@playwright/test';
import { Gateway } from '../../helpers/api';
import { stack, ADMIN_PASSWORD } from '../../setup/stacks';
import { API_OWNER as OWNER } from '../../helpers/personas';

// Backup and restore (B1), end to end, against a real gateway holding real rows.
//
// ── Why this spec exists ──────────────────────────────────────────────────────────────────────
//
// The backup engine has extensive unit tests and a parity suite that drives it against two
// databases at once. All of it is beneath the HTTP layer. Nothing until now has proved the claim
// an operator actually relies on: that the file this gateway hands you can be given back to it
// and rebuild it. Every part of that sentence — the download, the upload, the multipart encoding,
// the passphrase, the owner guard, the audit trail — lives above the engine, and the engine's
// green suite says nothing about any of it.
//
// It is also the coverage this repository has already been burned by once. The Storage card was
// "confirmed" against the static demo, which renders a captured payload; 06-storage-backend.spec
// exists because that proved the component and not the product. Backup has the same shape — a
// panel that draws whatever it is handed — and this is the spec that closes the same gap for it.
//
// ── The round trip, and why a MERGE is the strongest thing to assert ──────────────────────────
//
// This spec exports the gateway and then feeds the file straight back to the gateway that wrote
// it. That makes the expected answer exact rather than approximate: every row in the file is
// already present, under the same primary key, so a faithful file MERGES to zero rows written and
// every row skipped. One byte wrong anywhere in the codec, the encryption, the streaming or the
// multipart upload and that identity breaks — either the file will not open, or it opens to rows
// that no longer match what they came from. There is no way to pass this by accident.
//
// The `replace` at the end is the other half: it empties every table and rebuilds the gateway from
// the file alone, which is the operation the whole feature is FOR. It runs last, deliberately.
//
// ── 07-, on purpose ───────────────────────────────────────────────────────────────────────────
//
// After 01–06, so the export has a gateway with history in it to carry — accounts, tokens, teams,
// provider config and usage — rather than an empty one where a broken backup and a working backup
// produce the same file. Before 98-reset, which destroys everything.
test.describe.configure({ mode: 'serial' });

const gw = new Gateway(stack('api').baseURL);

/** Long enough to satisfy `passphraseProblem`, which is itself under test below. */
const PASSPHRASE = 'e2e-backup-passphrase-2026';
const RESTORE_PHRASE = 'REPLACE ALL DATA';

/** The header line's shape, as `lib/backup/format.ts` writes it. */
interface BackupHeader {
  format: string;
  version: number;
  cipher: { name: string; iv: string };
  recipients: { type: string }[];
}

interface RestoreReply {
  gatewayVersion: string;
  createdAt: string;
  sourceEngine: string;
  totalRowsInFile: number;
  rowsInFile: Record<string, number>;
  secretsInFile: number;
  missingEnv: string[];
  schemaDrift: unknown[];
  mode: string;
  dryRun: boolean;
  totalWritten: number;
  totalSkipped: number;
  collisions: { model: string; column: string; count: number }[];
  secretsRekeyed: number;
  tablesCleared: number;
  kvKeysCleared: number;
  error?: string;
  hint?: string;
}

let ownerToken = '';

/** The downloaded backup, held across the whole story. Every restore test re-uploads this. */
let backup: Buffer = Buffer.alloc(0);

test.beforeAll(async () => {
  ownerToken = await gw.login(OWNER.email, OWNER.password);
});

// ── Who may take one ──────────────────────────────────────────────────────────

test('an unauthenticated caller cannot export the gateway', async () => {
  const res = await gw.download('/admin/backup/export', { body: { passphrase: PASSPHRASE } });
  expect(res.status).toBe(401);
});

test('a viewer credential is refused — an export is every secret in one file', async () => {
  // The least credential the gateway can issue, pointed at the most sensitive route it has. A
  // viewer can read the dashboard; that must not extend to walking out with every provider key,
  // every team key and every TOTP secret in a single download.
  const minted = await gw.post<{ token: { token: string } }>('/admin/tokens', {
    token: ownerToken, body: { name: 'backup-probe', role: 'viewer' },
  });
  const viewerToken = minted.body.token.token;

  const res = await gw.download('/admin/backup/export', {
    token: viewerToken, body: { passphrase: PASSPHRASE },
  });
  expect(res.status).toBe(403);
});

test('a passphrase too short to protect the file is refused, and says why', async () => {
  const res = await gw.post<{ error: string }>('/admin/backup/export', {
    token: ownerToken, body: { passphrase: 'short' },
  });
  expect(res.status).toBe(400);
  // Not merely "invalid": the refusal has to teach the rule, or the operator's next guess is
  // another short one.
  expect(res.body.error).toContain('12 characters');
});

// ── The file itself ───────────────────────────────────────────────────────────

test('the owner downloads a real, sealed backup file', async () => {
  const res = await gw.download('/admin/backup/export', {
    token: ownerToken, body: { passphrase: PASSPHRASE },
  });
  expect(res.status).toBe(200);

  // The most sensitive response the gateway can produce. None of these headers is decoration:
  // without them a proxy may cache every credential in the deployment to disk.
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-disposition')).toMatch(
    /^attachment; filename="alayra-nexus-backup-[\d-]+\.nxb"$/,
  );

  expect(res.bytes.length).toBeGreaterThan(0);

  // The first line is plaintext JSON by design — an operator must be able to tell what a file is,
  // and which key opens it, without first proving they can open it.
  const newline = res.bytes.indexOf(0x0a);
  expect(newline, 'a backup must carry a header line').toBeGreaterThan(0);
  const header = JSON.parse(res.bytes.subarray(0, newline).toString('utf8')) as BackupHeader;

  expect(header.format).toBe('alayra-nexus-backup');
  expect(header.version).toBe(1);
  expect(header.cipher.name).toBe('aes-256-gcm');

  const types = header.recipients.map((r) => r.type);
  expect(types, 'the passphrase just typed must be able to open this').toContain('passphrase');
  // `includeGatewayRecipient` was not asked for, so the file must NOT carry a second way in. A
  // downloaded backup leaves the building; wrapping it for this gateway as well, unasked, would
  // silently widen who can open it.
  expect(types).not.toContain('gateway');

  // Everything after the header is ciphertext. If the owner's own email were readable in it, the
  // encryption is not doing the one thing it is there for — and a spec that only checked the
  // header would never notice.
  const sealed = res.bytes.subarray(newline + 1);
  expect(sealed.length).toBeGreaterThan(0);
  expect(sealed.includes(Buffer.from(OWNER.email, 'utf8'))).toBe(false);

  backup = res.bytes;
});

// ── Giving it back ────────────────────────────────────────────────────────────

test('the wrong passphrase opens nothing, and the refusal says nothing changed', async () => {
  const res = await gw.upload<RestoreReply>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: backup, filename: 'backup.nxb' },
    fields: { passphrase: 'definitely-not-the-passphrase', mode: 'merge', dryRun: 'true' },
  });
  expect(res.status).toBe(400);
  // The hint is the point. An operator who has just been told their restore failed will otherwise
  // assume the gateway is now half-written, and the recovery from that belief is worse than the
  // original mistake.
  expect(res.body.hint).toContain('Nothing was changed');
});

test('a dry run reports what the file holds and writes nothing', async () => {
  const res = await gw.upload<RestoreReply>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: backup, filename: 'backup.nxb' },
    fields: { passphrase: PASSPHRASE, mode: 'merge', dryRun: 'true' },
  });
  expect(res.status).toBe(200);

  const r = res.body;
  expect(r.dryRun).toBe(true);
  expect(r.mode).toBe('merge');

  // The file describes where it came from — this stack is a real PostgreSQL, and a file that
  // claimed otherwise would mean the manifest is not reading the live engine.
  expect(r.sourceEngine).toBe('postgres');
  expect(r.gatewayVersion).not.toBe('unknown');
  expect(Date.parse(r.createdAt)).not.toBeNaN();

  // Six specs' worth of accounts, tokens, teams, providers and usage. A single-digit total would
  // mean the export walked an almost-empty model list and still called itself a backup.
  expect(r.totalRowsInFile).toBeGreaterThan(10);

  // Keyed by PRISMA DELEGATE name — `adminUser`, not `AdminUser` — because that is the string
  // `MODEL_ORDER` holds and indexes the client with. Naming the models the earlier specs actually
  // built ties the file to the story: an export that quietly skipped a table would still produce a
  // plausible total, and only a per-model check notices.
  expect(r.rowsInFile.adminUser).toBeGreaterThan(0);      // 01-first-run, 02-accounts
  expect(r.rowsInFile.nexusProvider).toBeGreaterThan(0);  // 03-proxy configured a pool
  expect(r.rowsInFile.nexusKey).toBeGreaterThan(0);       // ...with a key, which is an encrypted secret

  // A dry run writes nothing. That is the whole contract.
  expect(r.totalWritten).toBe(0);
  expect(r.tablesCleared).toBe(0);
  expect(r.kvKeysCleared).toBe(0);

  // The gateway is being offered its OWN file, so every row's unique values already belong to the
  // very row they came from. A collision here would mean the export and the restore disagree about
  // what identifies a row — the exact defect A1 added collision detection to catch.
  expect(r.collisions).toEqual([]);

  // Same gateway, same environment: nothing the source had configured can be missing here, and the
  // schema cannot have drifted from itself.
  expect(r.missingEnv).toEqual([]);
  expect(r.schemaDrift).toEqual([]);

  // The gateway is still serving. A dry run is not maintenance.
  const live = await gw.get<{ active: boolean }>('/admin/backup/maintenance', ownerToken);
  expect(live.body.active).toBe(false);
});

test('a merge of the gateway’s own backup changes nothing — every row is already home', async () => {
  // The round trip, stated as an identity. If the file is faithful, nothing in it is new: written
  // must be zero and skipped must account for every row the file holds. Any corruption in the
  // codec, the cipher, the streaming or the multipart upload breaks that equality — this cannot
  // pass by luck.
  const res = await gw.upload<RestoreReply>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: backup, filename: 'backup.nxb' },
    fields: { passphrase: PASSPHRASE, mode: 'merge', dryRun: 'false' },
  });
  expect(res.status).toBe(200);

  const r = res.body;
  expect(r.dryRun).toBe(false);
  expect(r.totalWritten).toBe(0);
  expect(r.totalSkipped).toBe(r.totalRowsInFile);
  expect(r.tablesCleared).toBe(0);

  // A merge removes nothing, so no session it did not create can have become wrong — signing
  // everyone out of an operation defined as non-destructive would contradict what it is. The token
  // that asked for the merge still works.
  expect((await gw.get('/admin/me', ownerToken)).status).toBe(200);
});

// ── The proofs `replace` demands, each tested alone ───────────────────────────

test('replace refuses without the typed phrase', async () => {
  const res = await gw.upload<RestoreReply>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: backup, filename: 'backup.nxb' },
    fields: {
      passphrase: PASSPHRASE, mode: 'replace', dryRun: 'false',
      masterPassword: ADMIN_PASSWORD, confirm: 'replace all data',
    },
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain(RESTORE_PHRASE); // the refusal teaches the exact phrase
});

test('replace refuses without the environment’s master password', async () => {
  const res = await gw.upload<RestoreReply>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: backup, filename: 'backup.nxb' },
    fields: {
      passphrase: PASSPHRASE, mode: 'replace', dryRun: 'false',
      masterPassword: 'not-the-install-secret', confirm: RESTORE_PHRASE,
    },
  });
  expect(res.status).toBe(401);
});

// ── The trail ─────────────────────────────────────────────────────────────────

test('every export and every refusal is in the audit trail', async () => {
  // Before the replace, because a replace restores the file's audit rows over this spec's own.
  interface Entry { action: string; status: number; actorRole: string; detail: string | null }

  const trail = async (): Promise<Entry[]> => {
    const res = await gw.get<{ entries: Entry[] }>('/admin/audit?limit=200', ownerToken);
    return res.body.entries.filter((e) => e.action.startsWith('backup.'));
  };

  // Each backup route writes the DETAILED row; a global `onResponse` hook (routes/admin/index.ts)
  // writes a second, coarser row with no detail for the same request. Matching on `e.detail` picks
  // the record this test is actually making a claim about — without it, `find` returns whichever of
  // the pair the ordering happened to put first, which is not a property worth depending on.
  const found = async () => {
    const t = await trail();
    return {
      exported: t.find((e) => e.action === 'backup.export' && e.status === 200 && e.detail),
      refused:  t.find((e) => (e.detail ?? '').includes('refused_master_password')),
      dryRun:   t.find((e) => e.action === 'backup.restore.dryrun' && e.status === 200 && e.detail),
    };
  };

  // Polled on the three entries this test is ABOUT, not on a count. `recordAudit` buffers and a
  // background timer flushes every two seconds, so the trail lags the actions that produced it — and
  // a count reaches its threshold while the newest entries are still in the buffer. Written as a
  // count first, and it failed in exactly that way: the older rows satisfied it and the refusal this
  // test exists to find had not landed yet.
  await expect.poll(
    async () => Object.values(await found()).filter(Boolean).length,
    { message: 'the backup trail never arrived in full' },
  ).toBe(3);

  const { exported, refused, dryRun } = await found();

  // The successful export. "Who took a copy of every credential, and when" must have an answer.
  expect(exported!.actorRole).toBe('owner');
  const detail = JSON.parse(exported!.detail!) as {
    filename: string; rows: number; secrets: number; gatewayRecipient: boolean;
  };
  expect(detail.filename).toMatch(/\.nxb$/);
  expect(detail.rows).toBeGreaterThan(10);
  // The gateway had provider credentials in it, so a zero here would mean the trail is reporting a
  // backup of secrets that contains none.
  expect(detail.secrets).toBeGreaterThan(0);
  // Recorded because it changes who can open the file — an auditor should not have to guess.
  expect(detail.gatewayRecipient).toBe(false);

  // And the refusals — especially these. A wrong master password against a restore is
  // indistinguishable from someone probing, and this trail is the only place it would show up.
  expect(refused!.status).toBe(401);
  expect(refused!.action).toBe('backup.restore');

  expect(JSON.parse(dryRun!.detail!)).toMatchObject({ mode: 'merge', written: 0 });
});

// ── Rebuilding the gateway from the file alone ────────────────────────────────

test('all three proofs together rebuild the gateway from its own backup', async () => {
  // The operation the whole feature exists for, and the slowest: it empties every table under an
  // exclusive lock, writes every row back, re-keys every secret and then clears the KV.
  test.setTimeout(120_000);

  const res = await gw.upload<RestoreReply>('/admin/backup/restore', {
    token: ownerToken,
    file: { bytes: backup, filename: 'backup.nxb' },
    fields: {
      passphrase: PASSPHRASE, mode: 'replace', dryRun: 'false',
      masterPassword: ADMIN_PASSWORD, confirm: RESTORE_PHRASE,
    },
  });
  expect(res.status).toBe(200);

  const r = res.body;
  expect(r.mode).toBe('replace');
  expect(r.tablesCleared).toBeGreaterThan(0);

  // Nothing may be dropped. Under `merge` a skip means "already here"; under `replace` the tables
  // were emptied first, so a skipped row is a row that did not make it back — silent data loss
  // wearing a 200. The engine refuses rather than report it, and this is the assertion that keeps
  // that refusal honest at the HTTP layer.
  expect(r.totalWritten).toBe(r.totalRowsInFile);
  expect(r.totalSkipped).toBe(0);

  // Secrets were sealed with this gateway's key on the way out and re-sealed on the way in. A zero
  // here would mean the provider keys came back as ciphertext nobody can open.
  expect(r.secretsRekeyed).toBeGreaterThan(0);

  // Sessions, rate-limit counters, breaker state and cached settings all described the gateway that
  // just stopped existing. A session minted before the restore keeps its full role against wholly
  // different data if this wipe does not happen (A2) — so it must have happened.
  expect(r.kvKeysCleared).toBeGreaterThan(0);
  expect((await gw.get('/admin/me', ownerToken)).status).toBe(401);

  // The gateway must not be left refusing traffic. `endMaintenance` runs after the wipe, and a
  // restore that finished behind a flag nobody lowered is an outage the operator did not choose.
  const health = await gw.get<{ ok: boolean }>('/health');
  expect(health.status).toBe(200);

  // And the account is genuinely back: the owner signs in with the SAME password, which only works
  // if the hash survived the round trip and was re-keyed correctly. This is the sentence the whole
  // feature promises — the gateway was rebuilt from a file and it is the same gateway.
  const reborn = await gw.login(OWNER.email, OWNER.password);
  expect((await gw.get('/admin/me', reborn)).status).toBe(200);
});
