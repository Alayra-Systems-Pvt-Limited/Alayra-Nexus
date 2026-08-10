<sub>Part of the [Alayra Nexus README](../README.md#backup--restore), moved into its own page so the README stays inside npm's 64 KB render limit. The content is unchanged.</sub>

## Backup & restore

**Admin → Backup**, owner-only. Export writes the whole gateway to one encrypted file; restore takes
it back — on this gateway, or on a different one entirely.

What makes it portable rather than merely restorable: **every encrypted secret is re-keyed in
transit.** Provider keys, team keys and TOTP secrets are decrypted with the source gateway's
`MASTER_ENCRYPTION_KEY` and re-sealed with the target's. A file copy cannot do this — restore a
Postgres dump onto a gateway with a different master key and every credential in it is unreadable.

Which is why the same file moves between engines. Verified end to end: a **22.6 MB** backup taken
from a PostgreSQL gateway, restored into a standalone SQLite gateway holding a *different* master
key — **51,033 rows across 16 tables, 18 secrets re-keyed.** The provider key decrypts to identical
plaintext on both sides, the two ciphertexts differ, and the SQLite row cannot be opened with the
PostgreSQL key.

### Exporting

Choose a passphrase of **at least 12 characters**. It is the only thing between a stolen backup file
and every API key in the gateway, and — unless you also wrapped the file for another recipient — the
only way to open it again.

One file key is wrapped for up to three **recipients**, so a backup can outlive either loss:

| Recipient | What opens it | When to use it |
|---|---|---|
| **Passphrase** | Something you know | Always. The default |
| **Gateway** | A subkey of this deployment's `MASTER_ENCRYPTION_KEY` | Unattended work. Off unless asked — a downloaded file leaves the building, and this recipient only helps someone who already has your `.env` |
| **Recovery** | The X25519 private key from your Recovery Kit, shown once at install | Disaster recovery. The server holds only the public half, so a stolen gateway yields no way in |

A gateway-only file is **refused at write time**: it would be unopenable the moment the machine it
came from is gone, which is exactly the disaster this feature exists to prevent.

### Restoring

**Every restore is dry-run first.** There is no path to a destructive one that skips the report. The
report names the source gateway and engine, the row counts, what would collide, what would be
dropped, and any environment variables the source had set that this gateway does not.

| Mode | What it does |
|---|---|
| **Merge** | Adds new rows and updates matching ones. Everything else is left alone |
| **Replace everything** | Empties all 16 tables first, then loads the backup. The gateway enters maintenance with a live progress figure and a shared countdown |

The restore **refuses** a backup whose schema this gateway cannot honestly restore, and lists the
specific differences rather than failing partway through. After a replace, the counter/session store
is invalidated so no stale rate-limit window survives its own data.

> [!IMPORTANT]
> A backup contains every provider key, every team key, every TOTP secret and the full audit trail.
> It is as sensitive as the gateway itself. **`.env` is deliberately not included** — carrying it
> would mean a stolen backup also handed over your SSO and SMTP credentials.

### Over the API

```bash
curl -X POST http://localhost:3000/admin/backup/export \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"passphrase":"correct horse battery staple"}' -o backup.nxb
```

Dry run first — writes nothing, and returns the same report the dashboard shows:

```bash
curl -X POST http://localhost:3000/admin/backup/restore \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@backup.nxb -F passphrase='correct horse battery staple' \
  -F mode=replace -F dryRun=true
```

Then the real one. A destructive restore needs two further proofs — the exact phrase, and the
administrator password from the **server's** environment, which a stolen dashboard session does not
carry:

```bash
curl -X POST http://localhost:3000/admin/backup/restore \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@backup.nxb -F passphrase='correct horse battery staple' \
  -F mode=replace -F dryRun=false \
  -F confirm='REPLACE ALL DATA' -F masterPassword="$ADMIN_PASSWORD"
```

Owner-only and rate-limited. Audited as `backup.export`, `backup.restore.dryrun` and
`backup.restore`. Upload size is capped by `NEXUS_MAX_BACKUP_BYTES`.

> [!NOTE]
> **Scheduled and off-box backups are not built yet.** Today an export is something a person runs.
> A backup written to the same disk as the gateway is lost to the same accident, so download it
> somewhere else.

---
