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

// Turning a backup schedule into sentences (Phase B2).
//
// Pure and separate from the card, because this is the half that can be wrong in ways a screenshot
// will not show. A schedule is stored in UTC and read by a person who lives somewhere; "04:00" is a
// number that means nothing until it is 9 in the morning where they are. Getting that wrong produces
// an operator who believes their backups run at breakfast and finds out otherwise.

/** Mirrors MAX_EVERY_DAYS / MAX_KEEP in src/lib/backupSchedule.ts. */
export const MAX_EVERY_DAYS = 30;
export const MAX_KEEP = 365;

/**
 * Why a folder cannot be used, or null — mirroring `destinationProblem` in lib/backupSchedule.ts.
 *
 * Duplicated for the same reason ExportCard duplicates the passphrase rule: the server is the
 * authority and refuses regardless, but an operator typing a path deserves to be told before they
 * press Save, and there is no endpoint that answers "would you accept this?" without also doing the
 * work. The wording is copied verbatim so the two never say different things about the same path.
 */
export function pathProblem(path: string): string | null {
  const p = path.trim();
  if (p.length === 0) return 'Choose a folder for the gateway to write backups into.';
  const absolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (!absolute) {
    return 'Use a full path, starting from the root of the disk — a relative path means somewhere different depending on how the gateway was started.';
  }
  return null;
}

/** 4, 0 → "04:00". Zero-padded, because a schedule read at a glance should not need parsing. */
export function utcClock(hourUtc: number, minuteUtc: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hourUtc)}:${pad(minuteUtc)}`;
}

/**
 * The instant this UTC time-of-day falls on TODAY, for previewing a time the operator is still
 * choosing. Anchored to a real date rather than an arbitrary one so the local rendering below lands
 * on the right side of whatever daylight-saving rule applies where they are.
 */
export function utcInstantToday(hourUtc: number, minuteUtc: number, now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, minuteUtc);
}

/**
 * Guard for the two formatters below.
 *
 * `toLocaleString` does NOT throw on an unrenderable instant — it answers the literal string
 * "Invalid Date", which a try/catch cannot see and which would have been printed into the card as
 * though it were a time. The check has to be made before the call, not around it.
 */
const renderable = (atMs: number): boolean => Number.isFinite(atMs) && !Number.isNaN(new Date(atMs).getTime());

/** That instant as the reader's own clock reads it: "9:00 AM". Empty if it cannot be rendered. */
export function localClock(atMs: number): string {
  if (!renderable(atMs)) return '';
  try {
    return new Date(atMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** The reader's time zone, named — "Asia/Karachi". Empty when the browser will not say. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** A full local date and time for a specific run: "Sat 2 Aug, 9:00 AM". */
export function localMoment(atMs: number): string {
  if (!renderable(atMs)) return '';
  try {
    return new Date(atMs).toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * How long until something, phrased the way a countdown is read: "in 6h 12m".
 *
 * Two units at most. A backup due "in 6h 12m 41s" implies a precision nobody needs and churns on
 * screen every second; the card re-reads this every half minute and the second unit is what keeps
 * that from looking frozen.
 */
export function untilText(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'due now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `in ${days}d` : `in ${days}d ${rest}h`;
}

/** "Every day" / "Every other day" / "Every 3 days". */
export function cadenceText(everyDays: number): string {
  if (everyDays <= 1) return 'Every day';
  if (everyDays === 2) return 'Every other day';
  return `Every ${everyDays} days`;
}

/**
 * What `keep` actually buys, in time rather than in files.
 *
 * "Keep 7" means a week when the schedule is nightly and three weeks when it runs every third day,
 * and an operator choosing a retention number is thinking about how far back they can reach — not
 * about how many files sit in a folder.
 */
export function historyText(everyDays: number, keep: number): string {
  const days = Math.max(1, Math.round(everyDays * keep));
  if (days === 1) return 'about a day of history';
  if (days < 14) return `about ${days} days of history`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return `about ${weeks} week${weeks === 1 ? '' : 's'} of history`;
  }
  const months = Math.round(days / 30);
  return `about ${months} month${months === 1 ? '' : 's'} of history`;
}
