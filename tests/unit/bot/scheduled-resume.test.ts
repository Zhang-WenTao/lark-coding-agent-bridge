import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutoResumer,
  MAX_AUTO_RESUMES,
  describePendingResume,
  resumePromptFor,
  type PendingResume,
} from '../../../src/bot/auto-resume.js';
import {
  SCHEDULED_RESUME_GRACE_MS,
  SCHEDULED_RESUME_MAX_LEAD_MS,
  SCHEDULED_RESUME_MIN_LEAD_MS,
  decideScheduledResume,
  parseResumeTime,
  selfPauseDelay,
  type ScheduledResumeInput,
} from '../../../src/bot/scheduled-resume.js';
import { getSelfPauseFiveHourPercent, type AppConfig } from '../../../src/config/schema.js';
import { findLedger } from '../../../src/bot/task-ledger.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 2026-11-26 13:00 on the host clock. */
const NOW = new Date(2026, 10, 26, 13, 0, 0).getTime();
const MIN = 60_000;

function decide(overrides: Partial<ScheduledResumeInput> & Pick<ScheduledResumeInput, 'request'>) {
  return decideScheduledResume({ now: NOW, ownerRun: true, attempt: 1, ...overrides });
}

describe('RESUME_AFTER: five_hour', () => {
  it('goes on a short grace after the current window resets, from the ledger the run announced', () => {
    const reset = NOW + 3 * 60 * MIN;
    const decision = decide({
      request: { kind: 'after', window: 'five_hour' },
      fiveHourResetAt: () => reset,
      ledgerFallback: '/tmp/announced.md',
    });
    expect(decision).toEqual({
      action: 'schedule',
      at: reset + SCHEDULED_RESUME_GRACE_MS,
      ledger: '/tmp/announced.md',
      note: { kind: 'scheduled', at: reset + SCHEDULED_RESUME_GRACE_MS, ledger: '/tmp/announced.md' },
    });
    // 1–2 minutes after the reset, counting the resumer's 15 s tick.
    expect(SCHEDULED_RESUME_GRACE_MS).toBeGreaterThanOrEqual(MIN);
    expect(SCHEDULED_RESUME_GRACE_MS + 15_000).toBeLessThanOrEqual(2 * MIN);
  });

  it("prefers the marker's own ledger", () => {
    const decision = decide({
      request: { kind: 'after', window: 'five_hour', ledger: '/tmp/marker.md' },
      fiveHourResetAt: () => NOW + 60 * MIN,
      ledgerFallback: '/tmp/announced.md',
    });
    expect(decision).toMatchObject({ action: 'schedule', ledger: '/tmp/marker.md' });
  });

  it('moves a reset that is about due, or already past, up to the earliest allowed time', () => {
    for (const reset of [NOW + MIN, NOW - 10 * MIN]) {
      const decision = decide({ request: { kind: 'after', window: 'five_hour' }, fiveHourResetAt: () => reset });
      expect(decision).toEqual({
        action: 'schedule',
        at: NOW + SCHEDULED_RESUME_MIN_LEAD_MS,
        note: { kind: 'scheduled', at: NOW + SCHEDULED_RESUME_MIN_LEAD_MS, clamped: true },
      });
    }
  });

  it('refuses when the reset time is unknown, or the window is not the 5-hour one', () => {
    expect(decide({ request: { kind: 'after', window: 'five_hour' }, fiveHourResetAt: () => undefined })).toMatchObject({
      action: 'reject',
      reason: 'no-reset',
    });
    expect(decide({ request: { kind: 'after', window: 'five_hour' } })).toMatchObject({ reason: 'no-reset' });
    expect(decide({ request: { kind: 'after', window: 'seven_day' }, fiveHourResetAt: () => NOW + MIN })).toMatchObject({
      reason: 'bad-window',
    });
  });
});

describe('RESUME_AT', () => {
  it('takes an ISO time on the host clock, with or without an offset', () => {
    expect(decide({ request: { kind: 'at', time: '2026-11-26T18:00' } })).toMatchObject({
      action: 'schedule',
      at: new Date(2026, 10, 26, 18, 0).getTime(),
    });
    expect(parseResumeTime('2026-11-26 18:00:30', NOW)).toBe(new Date(2026, 10, 26, 18, 0, 30).getTime());
    expect(parseResumeTime('2026-11-26T10:00:00Z', NOW)).toBe(Date.UTC(2026, 10, 26, 10, 0));
    expect(parseResumeTime('2026-11-26T18:00+0800', NOW)).toBe(Date.UTC(2026, 10, 26, 10, 0));
    expect(parseResumeTime('2026-11-26T9:30', NOW)).toBe(new Date(2026, 10, 26, 9, 30).getTime());
  });

  it('reads a bare HH:MM as the next time the clock shows it', () => {
    expect(parseResumeTime('18:00', NOW)).toBe(new Date(2026, 10, 26, 18, 0).getTime());
    expect(parseResumeTime('09:15', NOW)).toBe(new Date(2026, 10, 27, 9, 15).getTime());
    expect(parseResumeTime('13:00', NOW)).toBe(new Date(2026, 10, 27, 13, 0).getTime());
    expect(parseResumeTime('25:00', NOW)).toBeUndefined();
  });

  it('moves a time under 5 minutes away up to 5 minutes, and refuses past, far or unreadable times', () => {
    expect(decide({ request: { kind: 'at', time: '13:02' } })).toMatchObject({
      action: 'schedule',
      at: NOW + SCHEDULED_RESUME_MIN_LEAD_MS,
      note: { clamped: true },
    });
    expect(decide({ request: { kind: 'at', time: '2026-11-26T12:00' } })).toMatchObject({ reason: 'past' });
    expect(decide({ request: { kind: 'at', time: '2026-11-28T09:00' } })).toMatchObject({ reason: 'too-far' });
    const justInside = new Date(NOW + SCHEDULED_RESUME_MAX_LEAD_MS);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(decide({ request: { kind: 'at', time: iso(justInside) } })).toMatchObject({ action: 'schedule' });
    for (const time of ['明天下午', '6pm', '', '2026/11/26 18:00']) {
      expect(decide({ request: { kind: 'at', time } })).toMatchObject({ action: 'reject', reason: 'bad-time' });
    }
  });

  it('refuses a ledger that is not an absolute path', () => {
    expect(decide({ request: { kind: 'at', time: '18:00', ledger: 'notes/plan.md' } })).toMatchObject({
      reason: 'bad-ledger',
    });
    expect(decide({ request: { kind: 'at', time: '18:00', ledger: '~/plan.md' } })).toMatchObject({
      action: 'schedule',
      ledger: '~/plan.md',
    });
  });
});

describe('gates', () => {
  it("honours only the owner's runs, cancelling included", () => {
    for (const request of [
      { kind: 'after', window: 'five_hour' },
      { kind: 'at', time: '18:00' },
      { kind: 'cancel' },
    ] as const) {
      expect(decide({ request, ownerRun: false, fiveHourResetAt: () => NOW + 60 * MIN })).toEqual({
        action: 'reject',
        reason: 'not-owner',
        note: { kind: 'rejected', reason: 'not-owner' },
      });
    }
  });

  it('stops chaining after MAX_AUTO_RESUMES resumes in a row', () => {
    expect(decide({ request: { kind: 'at', time: '18:00' }, attempt: MAX_AUTO_RESUMES })).toMatchObject({
      action: 'schedule',
    });
    expect(decide({ request: { kind: 'at', time: '18:00' }, attempt: MAX_AUTO_RESUMES + 1 })).toMatchObject({
      reason: 'too-many',
    });
  });

  it('cancels, noting the time it drops when one was pending', () => {
    expect(decide({ request: { kind: 'cancel' }, pending: { resumeAt: NOW + 60 * MIN } })).toEqual({
      action: 'cancel',
      note: { kind: 'cancelled', at: NOW + 60 * MIN },
    });
    expect(decide({ request: { kind: 'cancel' } })).toEqual({ action: 'cancel' });
  });
});

describe('scheduled resumes in the AutoResumer', () => {
  function scheduled(overrides: Partial<PendingResume> = {}): PendingResume {
    return {
      scope: 'oc_dm',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_owner',
      originMessageId: 'om_task',
      resumeAt: NOW + 3 * 60 * MIN,
      kind: 'scheduled',
      ledger: '/tmp/plan.md',
      attempt: 1,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('fires on its timer once due — after a restart too, from auto-resume.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scheduled-resume-'));
    dirs.push(dir);
    const file = join(dir, 'auto-resume.json');
    const first = new AutoResumer({ file, fire: async () => {} });
    await first.schedule(scheduled());
    first.stop();
    const saved = JSON.parse(await readFile(file, 'utf8')).resumes.oc_dm;
    expect(saved).toMatchObject({ kind: 'scheduled', ledger: '/tmp/plan.md', resumeAt: NOW + 3 * 60 * MIN });

    // The next process: only the interval and the clock are faked, file I/O stays real.
    vi.useFakeTimers({ now: NOW + 60 * MIN, toFake: ['setInterval', 'clearInterval', 'Date'] });
    const fire = vi.fn(async (_resume: PendingResume) => {});
    const second = new AutoResumer({ file, fire, tickMs: 15_000 });
    await second.load();
    second.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN - 15_000);
    await settle();
    expect(fire).not.toHaveBeenCalled();
    expect(second.get('oc_dm')?.kind).toBe('scheduled');

    await vi.advanceTimersByTimeAsync(15_000);
    await settle(() => fire.mock.calls.length > 0);
    second.stop();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]![0]).toMatchObject({ kind: 'scheduled', ledger: '/tmp/plan.md', originMessageId: 'om_task' });
    expect(second.get('oc_dm')).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8')).resumes).toEqual({});
    // The resumed run pausing again is the next attempt in the chain.
    expect(second.nextAttempt('oc_dm', true)).toBe(2);
  });

  it('a newer marker in the same scope replaces the older one', async () => {
    const r = new AutoResumer({ fire: async () => {} });
    await r.schedule(scheduled({ resumeAt: NOW + MIN * 10 }));
    await r.schedule(scheduled({ resumeAt: NOW + MIN * 20, ledger: '/tmp/other.md' }));
    expect(r.get('oc_dm')).toMatchObject({ resumeAt: NOW + MIN * 20, ledger: '/tmp/other.md' });
  });

  it('tells the resumed run to go on from the ledger, which the next marker can fall back to', () => {
    const prompt = resumePromptFor(scheduled());
    expect(prompt).toContain('[自动继续]');
    expect(prompt).toContain('/tmp/plan.md');
    expect(findLedger(prompt)).toBe('/tmp/plan.md');
    const bare = resumePromptFor(scheduled({ ledger: undefined }));
    expect(bare).toContain('从暂停的地方接着做');
    expect(findLedger(bare)).toBeUndefined();
    expect(resumePromptFor(scheduled({ locale: 'en' }))).toContain('[auto-resume]');
  });

  it('describes itself in /status', () => {
    expect(describePendingResume(scheduled())).toContain('按约定暂停');
    expect(describePendingResume(scheduled({ kind: 'interrupted' }))).toContain('按任务台账自动继续');
    expect(describePendingResume(scheduled({ kind: undefined, limitType: 'five_hour' }))).toContain('5 小时额度用完暂停');
  });
});

describe('the self-pause line (preferences.selfPause)', () => {
  const reset = NOW + 2 * 60 * MIN;
  const reading = (usedPercent: number, resets: string | null = new Date(reset).toISOString()) => ({
    windows: [
      { label: '5 小时窗口', usedPercent, ...(resets !== null ? { resets } : {}) },
      { label: '本周', usedPercent: 20 },
    ],
  });

  it('postpones a due resume to the reset while the 5-hour window is past the line', () => {
    expect(selfPauseDelay(reading(63), 50, NOW)).toEqual({ usedPercent: 63, until: reset + SCHEDULED_RESUME_GRACE_MS });
    // Claude's own wording of the reset works as well.
    const claude = { windows: [{ label: '5 小时窗口', usedPercent: 80, resets: 'Nov 26, 3pm (UTC)' }] };
    expect(selfPauseDelay(claude, 50, Date.UTC(2026, 10, 26, 13))).toEqual({
      usedPercent: 80,
      until: Date.UTC(2026, 10, 26, 15) + SCHEDULED_RESUME_GRACE_MS,
    });
  });

  it('goes on at or under the line, and whenever the quota or its reset cannot be read', () => {
    expect(selfPauseDelay(reading(50), 50, NOW)).toBeUndefined();
    expect(selfPauseDelay(reading(12), 50, NOW)).toBeUndefined();
    expect(selfPauseDelay(undefined, 50, NOW)).toBeUndefined();
    expect(selfPauseDelay(reading(90, null), 50, NOW)).toBeUndefined();
    expect(selfPauseDelay(reading(90, 'soon'), 50, NOW)).toBeUndefined();
    expect(selfPauseDelay(reading(90, new Date(NOW - MIN).toISOString()), 50, NOW)).toBeUndefined();
  });

  it('counts a refused account as full', () => {
    expect(selfPauseDelay({ ...reading(30), blocked: true }, 50, NOW)).toMatchObject({ usedPercent: 100 });
  });

  it('is off unless a line from 1 to 100 is configured', () => {
    const cfg = (selfPause: unknown) => ({ preferences: { selfPause } }) as unknown as AppConfig;
    expect(getSelfPauseFiveHourPercent(cfg({ fiveHourPercent: 50 }))).toBe(50);
    expect(getSelfPauseFiveHourPercent(cfg(undefined))).toBeUndefined();
    expect(getSelfPauseFiveHourPercent(cfg({ fiveHourPercent: 0 }))).toBeUndefined();
    expect(getSelfPauseFiveHourPercent(cfg({ fiveHourPercent: 150 }))).toBeUndefined();
    expect(getSelfPauseFiveHourPercent(cfg({ fiveHourPercent: '50' }))).toBeUndefined();
  });
});

/** Let real file I/O finish (setTimeout is not faked here); up to ~2 s, or until `until` holds. */
async function settle(until?: () => boolean): Promise<void> {
  for (let i = 0; i < (until ? 400 : 10); i++) {
    if (until?.()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
