import { quotaResetAt, type QuotaReading } from '../agent/quota';
import type { ResumeNote, ResumeRejectReason, ResumeRequest } from '../card/resume-marker';
import { MAX_AUTO_RESUMES, type PendingResume } from './auto-resume';

/**
 * 按约定暂停: the agent stops a long owner task on purpose — the owner said to
 * work only while the 5-hour window is at most half used, say — and ends its
 * answer with a `[[RESUME_…]]` line (card/resume-marker). The bridge turns
 * that into a `scheduled` {@link PendingResume}: at the agreed time the task
 * goes on in the same chat, topic and session, from its task ledger.
 *
 * Gates, checked when the run that wrote the marker finishes:
 * - the owner's runs only — anyone else's marker is stripped and ignored;
 * - at least {@link SCHEDULED_RESUME_MIN_LEAD_MS} ahead (an earlier time is
 *   moved up to it), at most {@link SCHEDULED_RESUME_MAX_LEAD_MS} (refused);
 * - at most {@link MAX_AUTO_RESUMES} resumes in a row, counted with the other
 *   auto-resumes of the scope.
 */

/** Earliest a scheduled resume can be set for: no tight pause / resume loops. */
export const SCHEDULED_RESUME_MIN_LEAD_MS = 5 * 60_000;
/** Latest: a plan further out than a day is a job for `/cron`, not a pause. */
export const SCHEDULED_RESUME_MAX_LEAD_MS = 24 * 3_600_000;
/**
 * `RESUME_AFTER: five_hour` resumes this long past the reset, so the new
 * window is surely open; with the resumer's 15 s tick it starts 1.5–2 minutes
 * after the reset.
 */
export const SCHEDULED_RESUME_GRACE_MS = 90_000;

export type ScheduledResumeDecision =
  | { action: 'schedule'; at: number; ledger?: string; note: ResumeNote }
  /** `note` only when there was a pending resume to cancel. */
  | { action: 'cancel'; note?: ResumeNote }
  | { action: 'reject'; reason: ResumeRejectReason; note: ResumeNote };

export interface ScheduledResumeInput {
  request: ResumeRequest;
  now: number;
  /** The run was the bot owner's (every message in its batch). */
  ownerRun: boolean;
  /** The attempt the new resume would be (`AutoResumer.nextAttempt`). */
  attempt: number;
  /** When the current 5-hour window of the account the run used resets (epoch ms). */
  fiveHourResetAt?: () => number | undefined;
  /** The ledger to use when the marker names none: the one the run announced. */
  ledgerFallback?: string;
  /** The resume already pending in the scope, for the cancel note. */
  pending?: Pick<PendingResume, 'resumeAt'>;
}

export function decideScheduledResume(input: ScheduledResumeInput): ScheduledResumeDecision {
  const { request, now } = input;
  const reject = (reason: ResumeRejectReason): ScheduledResumeDecision => ({
    action: 'reject',
    reason,
    note: { kind: 'rejected', reason },
  });
  // A guest could talk the agent into writing a marker; only the owner plans the owner's time.
  if (!input.ownerRun) return reject('not-owner');
  if (request.kind === 'cancel') {
    return { action: 'cancel', ...(input.pending ? { note: { kind: 'cancelled', at: input.pending.resumeAt } } : {}) };
  }
  if (input.attempt > MAX_AUTO_RESUMES) return reject('too-many');
  if (request.ledger !== undefined && !isAbsolutePath(request.ledger)) return reject('bad-ledger');
  let at: number;
  if (request.kind === 'at') {
    const parsed = parseResumeTime(request.time, now);
    if (parsed === undefined) return reject('bad-time');
    if (parsed <= now) return reject('past');
    at = parsed;
  } else {
    if (request.window !== 'five_hour') return reject('bad-window');
    const reset = input.fiveHourResetAt?.();
    if (reset === undefined) return reject('no-reset');
    // A reset already behind us: the window is fresh, go on as soon as allowed.
    at = reset + SCHEDULED_RESUME_GRACE_MS;
  }
  if (at - now > SCHEDULED_RESUME_MAX_LEAD_MS) return reject('too-far');
  const earliest = now + SCHEDULED_RESUME_MIN_LEAD_MS;
  const clamped = at < earliest;
  if (clamped) at = earliest;
  const ledger = request.ledger ?? input.ledgerFallback;
  return {
    action: 'schedule',
    at,
    ...(ledger ? { ledger } : {}),
    note: { kind: 'scheduled', at, ...(ledger ? { ledger } : {}), ...(clamped ? { clamped: true } : {}) },
  };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/');
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/;

/**
 * A marker's time as epoch ms: an ISO date-time (no offset means the host's
 * clock), or `HH:MM` — the next time the host's clock shows it. Undefined
 * when it is neither.
 */
export function parseResumeTime(text: string, now: number): number | undefined {
  const value = text.trim();
  const clock = CLOCK_TIME.exec(value);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return undefined;
    const day = new Date(now);
    day.setHours(hours, minutes, 0, 0);
    if (day.getTime() <= now) day.setDate(day.getDate() + 1);
    return day.getTime();
  }
  if (!ISO_TIME.test(value)) return undefined;
  const iso = value
    .replace(' ', 'T')
    .replace(/T(\d):/, 'T0$1:')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : undefined;
}

/** How the quota readers label the 5-hour window (Claude `/usage`, Codex rate limits). */
const FIVE_HOUR_LABEL = '5 小时窗口';

/**
 * 自停线 (`preferences.selfPause.fiveHourPercent`): a scheduled resume that
 * comes due while the 5-hour window is used above `line` waits for that
 * window's reset instead of starting the agent — the owner's "only while it is
 * at most half used" holds at resume time too. Undefined (go on now) when the
 * window is at or under the line, or the reading or its reset is unknown: an
 * unreadable quota never holds a task back. After the reset the window starts
 * empty, so a postponed resume does not wait twice.
 */
export function selfPauseDelay(
  reading: QuotaReading | undefined,
  line: number,
  now: number,
): { usedPercent: number; until: number } | undefined {
  const window = reading?.windows.find((w) => w.label === FIVE_HOUR_LABEL);
  if (!window) return undefined;
  const usedPercent = reading?.blocked ? 100 : window.usedPercent;
  if (usedPercent <= line) return undefined;
  const reset = quotaResetAt(window.resets, now);
  if (reset === undefined || reset <= now) return undefined;
  return { usedPercent, until: reset + SCHEDULED_RESUME_GRACE_MS };
}
