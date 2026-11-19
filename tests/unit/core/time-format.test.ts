import { afterEach, describe, expect, it } from 'vitest';
import {
  formatAgoCompact,
  formatDateTime,
  formatHourMinute,
  formatLocalDate,
  formatMonthDayTime,
} from '../../../src/core/time-format';

const pad = (n: number): string => String(n).padStart(2, '0');

/** The copies these replaced, verbatim, to pin that every caller prints what it used to. */
const before = {
  /** card/i18n formatMoment, accounts formatClock, dream/format formatTime, templates time(), /audit */
  monthDayTime: (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  /** scheduler/runner formatTime */
  dateTime: (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  /** usage-ledger localDayKey, off-days localDate().key */
  localDate: (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  /** background-origins formatClock */
  hourMinute: (ms: number) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  /** commands/index + cli/ps formatAgo */
  ago: (ms: number) => {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
    return `${Math.floor(ms / 86_400_000)}d 前`;
  },
};

const moments = [
  0,
  Date.UTC(2026, 0, 1, 0, 0),
  Date.UTC(2026, 11, 31, 23, 59, 59),
  Date.UTC(2026, 2, 29, 1, 30), // EU DST switch
  Date.UTC(2026, 9, 4, 16, 30), // AU DST switch
  Date.UTC(2026, 10, 19, 14, 32, 55),
];

const zones = ['Asia/Shanghai', 'UTC', 'Europe/Berlin', 'Australia/Adelaide', 'America/Los_Angeles'];
const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('time formatting', () => {
  it('prints exactly what the replaced copies printed, in every time zone', () => {
    for (const tz of zones) {
      process.env.TZ = tz;
      for (const ms of moments) {
        const label = `${tz} ${ms}`;
        expect(formatMonthDayTime(ms), label).toBe(before.monthDayTime(ms));
        expect(formatDateTime(ms), label).toBe(before.dateTime(ms));
        expect(formatLocalDate(ms), label).toBe(before.localDate(ms));
        expect(formatHourMinute(ms), label).toBe(before.hourMinute(ms));
      }
    }
  });

  it('follows the local zone, not UTC', () => {
    process.env.TZ = 'Asia/Shanghai';
    expect(formatDateTime(Date.UTC(2026, 10, 19, 16, 30))).toBe('2026-11-20 00:30');
    expect(formatLocalDate(Date.UTC(2026, 10, 19, 16, 30))).toBe('2026-11-20');
  });

  it('says how long ago in one compact unit', () => {
    for (const ms of [0, 999, 59_999, 60_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000, 9 * 86_400_000]) {
      expect(formatAgoCompact(ms), String(ms)).toBe(before.ago(ms));
    }
    expect(formatAgoCompact(5 * 60_000)).toBe('5m 前');
  });
});
