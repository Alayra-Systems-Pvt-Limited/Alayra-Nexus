// A zero-dependency password-strength estimate for the sign-up screens. Deliberately NOT a security
// control — the gateway's real password rule is length (≥12), enforced server-side. This only gives
// the person live, honest feedback while they type, so "a long phrase beats a short complicated one"
// stops being just a hint and becomes something they can see.
//
// The score rewards length first (the dominant factor in real strength) and character variety
// second, then penalises the patterns that make a long password weak anyway: a single repeated
// character, a pure run of digits, or one of a handful of infamous choices.

export interface PasswordScore {
  /** 0 (unusable) … 4 (strong) — drives the four-segment meter. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

const COMMON = new Set([
  'password', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein', 'iloveyou', 'admin123', 'changeme', 'welcome1',
]);

const LABELS: Record<PasswordScore['score'], string> = {
  0: 'Too short',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
};

export function scorePassword(pw: string): PasswordScore {
  const len = pw.length;
  if (len === 0) return { score: 0, label: '' };
  // Below the server's own minimum, never flatter it — always the lowest rung.
  if (len < 12) return { score: 0, label: LABELS[0] };

  let points = 0;
  // Length is the main driver: another rung at 16 and 20 characters.
  points += 1;
  if (len >= 16) points += 1;
  if (len >= 20) points += 1;

  // Variety: a small bonus for mixing classes, so a 12-char mixed password can reach the top too.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-z0-9]/i].filter((re) => re.test(pw)).length;
  if (classes >= 3) points += 1;

  // Penalties that undo length: a single repeated char, all digits, or a known-bad password.
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) points = 0;
  else if (/^(.)\1+$/.test(pw)) points = 0;      // "aaaaaaaaaaaa"
  else if (/^\d+$/.test(pw)) points = Math.min(points, 1); // long but all digits

  const score = Math.max(0, Math.min(4, points)) as PasswordScore['score'];
  return { score, label: LABELS[score] };
}
