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
