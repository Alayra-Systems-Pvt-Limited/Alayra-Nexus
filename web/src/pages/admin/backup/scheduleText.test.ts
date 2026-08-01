import { describe, it, expect } from 'vitest';
import {
  pathProblem, utcClock, utcInstantToday, localClock, untilText, cadenceText, historyText,
} from './scheduleText';

describe('what a folder has to be', () => {
  it('refuses an empty one by asking for the thing that is missing', () => {
    expect(pathProblem('')).toMatch(/Choose a folder/);
    expect(pathProblem('   ')).toMatch(/Choose a folder/);
  });

  it('refuses a relative path, which means somewhere different depending on how the gateway started', () => {
    // Not pedantry: the working directory differs between `npx`, a systemd unit and a container, so
    // the same configuration would write to three places and two of them would be wrong.
    expect(pathProblem('backups')).toMatch(/full path/);
    expect(pathProblem('./backups')).toMatch(/full path/);
    expect(pathProblem('../backups')).toMatch(/full path/);
  });

  it('accepts the three shapes an absolute path takes on the platforms this runs on', () => {
    expect(pathProblem('/var/backups/nexus')).toBeNull();
    expect(pathProblem('C:\\backups')).toBeNull();
    expect(pathProblem('C:/backups')).toBeNull();
    expect(pathProblem('\\\\fileserver\\backups')).toBeNull();
  });

  it('judges the trimmed path, so a stray space is not a different answer from the server’s', () => {
    expect(pathProblem('  /var/backups  ')).toBeNull();
  });
});

describe('reading a schedule back', () => {
  it('zero-pads the clock, so a time is read rather than parsed', () => {
    expect(utcClock(4, 0)).toBe('04:00');
    expect(utcClock(23, 45)).toBe('23:45');
  });

  it('names what a cadence is, rather than restating the number', () => {
    expect(cadenceText(1)).toBe('Every day');
    expect(cadenceText(2)).toBe('Every other day');
    expect(cadenceText(7)).toBe('Every 7 days');
  });

  it('turns retention into time, because that is what an operator is choosing', () => {
    // "Keep 7" is a week nightly and three weeks every third day. The file count is the setting;
    // how far back you can reach is the decision.
    expect(historyText(1, 7)).toBe('about 7 days of history');
    expect(historyText(3, 7)).toBe('about 3 weeks of history');
    expect(historyText(1, 1)).toBe('about a day of history');
    expect(historyText(1, 90)).toBe('about 3 months of history');
    expect(historyText(1, 30)).toBe('about 4 weeks of history');
  });
});

describe('how long until the next one', () => {
  it('says nothing more precise than it knows', () => {
    expect(untilText(0)).toBe('due now');
    expect(untilText(-5_000)).toBe('due now');
    expect(untilText(30_000)).toBe('in under a minute');
    expect(untilText(45 * 60_000)).toBe('in 45m');
  });

  it('carries a second unit only when it is not zero, so “in 6h” is never “in 6h 0m”', () => {
    expect(untilText(6 * 3_600_000)).toBe('in 6h');
    expect(untilText(6 * 3_600_000 + 12 * 60_000)).toBe('in 6h 12m');
    expect(untilText(2 * 86_400_000)).toBe('in 2d');
    expect(untilText(2 * 86_400_000 + 3 * 3_600_000)).toBe('in 2d 3h');
  });
});

describe('the same time, on the reader’s clock', () => {
  it('anchors the preview to today, so it lands on the right side of a daylight-saving change', () => {
    // Midsummer and midwinter are the same UTC time-of-day and can be different local hours. The
    // instant is computed from the CURRENT date for exactly that reason.
    const july = Date.UTC(2026, 6, 15, 9, 30);
    const january = Date.UTC(2026, 0, 15, 9, 30);
    expect(new Date(utcInstantToday(4, 0, july)).toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(new Date(utcInstantToday(4, 0, january)).toISOString()).toBe('2026-01-15T04:00:00.000Z');
  });

  it('renders an hour and a minute and nothing else', () => {
    // The zone is the machine's, so the exact string is not assertable — but the shape is, and a
    // format that leaked seconds or a date would be wrong in every zone.
    expect(localClock(Date.UTC(2026, 6, 15, 4, 0))).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i);
  });

  it('answers with an empty string rather than throwing on an instant it cannot render', () => {
    // This labels a form control. A formatter that threw would take the whole card down over a
    // number, which is a strictly worse outcome than an unlabelled field.
    expect(localClock(Number.NaN)).toBe('');
  });
});
