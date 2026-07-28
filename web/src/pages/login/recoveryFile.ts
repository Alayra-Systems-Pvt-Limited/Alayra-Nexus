// The saved-file contents for a one-time account recovery key, shared by the three screens that
// reveal one (first-run claim, invite acceptance, and password recovery). Headed and dated so the
// file is recognisable in a downloads folder long after — this is the credential that gets a
// password back, and losing it means losing the account.
//
// The heading says "recovery key", not "API key": this proves who you are to sign in, it is not the
// gateway credential clients send. Conflating the two would send someone pasting this where it can
// never work.
export function recoveryKeyFile(key: string): string {
  const dated = new Date().toISOString().slice(0, 10);
  return `Alayra Nexus — Account recovery key\nIssued: ${dated}\n\n${key}\n\nKeep this secret. It restores your password if you are locked out, and it is shown only once.\n`;
}

export interface RecoveryKit {
  organisation: string;
  gatewayUrl: string;
  /** The account recovery key — gets a forgotten password back. */
  accountRecoveryKey: string;
  /** MASTER_ENCRYPTION_KEY. Empty when the server did not return one. */
  masterEncryptionKey: string;
  /**
   * The backup passphrase — but only when WE generated it.
   *
   * A self-chosen passphrase is deliberately left out and replaced with a blank line to write on.
   * People reuse passwords: if that file leaks, printing a chosen passphrase would expose not only
   * these backups but whatever else the same phrase unlocks. A generated one exists nowhere else in
   * their life, so writing it down is pure upside. It is the rule 1Password's Emergency Kit follows
   * — it prints the Secret Key and leaves the master password blank — and for exactly this reason.
   */
  backupPassphrase: string | null;
}

/**
 * One file holding everything an operator needs to recover this gateway (Phase C6).
 *
 * One file rather than three, because three things to keep safe is how two get kept and the third
 * is lost. Plain text rather than PDF, because it must print, open anywhere, and still be readable
 * by whatever exists in ten years.
 *
 * Each entry says what it unlocks in one line. "Recovery key" and "backup passphrase" are close
 * enough in name that an operator holding both without labels will eventually try the wrong one at
 * the worst possible moment.
 */
export function recoveryKitFile(kit: RecoveryKit): string {
  const dated = new Date().toISOString().slice(0, 10);

  const backup = kit.backupPassphrase
    ? `  ${kit.backupPassphrase}\n`
    : '  ______________________________________________________\n' +
      '  Write your backup passphrase here. You chose it yourself,\n' +
      '  so it was never sent to us and is not stored anywhere.\n';

  const master = kit.masterEncryptionKey
    ? `  ${kit.masterEncryptionKey}\n`
    : '  (not available — copy MASTER_ENCRYPTION_KEY from your server\'s .env)\n';

  return [
    'ALAYRA NEXUS — RECOVERY KIT',
    `Organisation: ${kit.organisation || 'Alayra Nexus'}`,
    `Gateway: ${kit.gatewayUrl}`,
    `Created: ${dated}`,
    '',
    'Keep this somewhere safe and offline. Anyone holding it can take over',
    'this gateway and open its backups.',
    '',
    '─────────────────────────────────────────────────────────────────────',
    '1. ACCOUNT RECOVERY KEY',
    '   Gets you back in if you forget your password.',
    '',
    `  ${kit.accountRecoveryKey}`,
    '',
    '─────────────────────────────────────────────────────────────────────',
    '2. MASTER ENCRYPTION KEY',
    '   Goes in your server config as MASTER_ENCRYPTION_KEY. Without it the',
    '   gateway cannot start and its stored keys cannot be decrypted.',
    '',
    master.trimEnd(),
    '',
    '─────────────────────────────────────────────────────────────────────',
    '3. BACKUP PASSPHRASE',
    '   Opens your backups on a NEW machine. This is the one that saves you',
    '   when the server is gone — a backup cannot be opened without it.',
    '',
    backup.trimEnd(),
    '',
    '─────────────────────────────────────────────────────────────────────',
    '',
    'Alayra Systems cannot recover any of these for you. There is no reset',
    'link and no support path that bypasses them. That is what makes them',
    'worth something.',
    '',
  ].join('\n');
}
