// Small, dependency-free formatters shared across the dashboard. Kept pure so they are trivial to
// test and reuse (numbers on stat cards, costs, "3m ago" timestamps in tables).

/** 1234 → "1.2K", 4_500_000 → "4.5M". Whole numbers under 1,000 are shown as-is. */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  const units: [string, number][] = [['B', 1e9], ['M', 1e6], ['K', 1e3]];
  for (const [suffix, div] of units) {
    if (abs >= div) {
      const v = n / div;
      return (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + suffix;
    }
  }
  return String(Math.round(n));
}

/** A cost in USD, honest about tiny non-zero spend: 0 → "$0", 0.004 → "<$0.01", 12.5 → "$12.50". */
export function currency(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0';
  if (Math.abs(usd) < 0.01) return '<$0.01';
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "2026-07-09" → "Jul 9" (UTC, so it matches the server's day buckets). */
export function shortDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * A byte count, in the units a person reads a file size in: 0 → "0 B", 1536 → "1.5 KB".
 *
 * Decimal units (1000), not binary (1024), because this labels things an operator compares against
 * what their file manager and their object store report — both of which are decimal. Being
 * internally consistent matters more here than being pedantically correct about KiB.
 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  // Bytes are never fractional; everything above shows one decimal until it is large enough not to.
  const shown = unit === 0 ? String(Math.round(value)) : value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/**
 * A duration in seconds, phrased as a person would say it: 45 → "45 seconds", 3700 → "1 hour".
 *
 * Deliberately coarse. This renders an ESTIMATE of how long a restore has left, recomputed from a
 * rate that moves; "1 hour 1 minute 40 seconds" would imply a precision the number does not have,
 * and would visibly churn every second. One unit, rounded, reads as the approximation it is.
 */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return plural(Math.max(1, Math.round(seconds)), 'second');
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute');
  return plural(Math.round(seconds / 3600), 'hour');
}

/** Coarse "time ago" for activity rows; falls back to the date once past a week. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return iso.slice(0, 10);
}
