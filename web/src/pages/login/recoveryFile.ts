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
