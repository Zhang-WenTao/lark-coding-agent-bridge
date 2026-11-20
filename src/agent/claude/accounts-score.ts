import { type LineCap, WINDOW_KINDS, type WindowKind, graceMs } from './accounts-model';

/** `10-21 15:00` in the machine's time zone. */
// ─── Account table and switching (`/accounts`, `claude-account switch`) ─────

/** Weights of the switch score's three terms (see {@link switchScore}). */
export const SWITCH_SCORE_WEIGHTS = { weekExpiring: 0.6, weekRoom: 0.15, fiveHourRoom: 0.25 } as const;
/**
 * Weekly room (as a share of the line) below which an account's coming reset
 * counts for less: a few points left are not worth a move (every move re-reads
 * the conversation uncached) — they are used once the account comes up anyway.
 */
export const WORTH_MOVING_ROOM = 0.1;
/**
 * How much better than the main account another has to score to take the next
 * run from it. Moving costs a full uncached read of the conversation (the
 * prompt cache is per account), so near-equal scores don't trade places.
 */
export const STICKY_MARGIN = 0.05;
/** Room assumed for an account that has never run here (its token is untested). */
const UNKNOWN_ROOM = 0.5;
export const WINDOW_MS: Record<WindowKind, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
const WEEK_MS = WINDOW_MS.seven_day;

export interface AccountWindowView {
  /** 0–100; undefined when no run reported this window yet. */
  usedPercent?: number;
  /** Until the window resets; undefined when unknown. */
  resetsInMs?: number;
  /** The window reset since the last report, so the usage reads 0. */
  reset?: boolean;
  /** The account's switch line for this window (1–100). */
  line: number;
  /** The window is about to reset, so its line is open up to {@link GRACE_LINE}: the line it had before. */
  graceFrom?: number;
  /** A rest day's longer near-reset span ({@link ClaudeAccountsConfig.offDayGraceHours}) is in force for it. */
  graceSpanMs?: number;
  /** Within that rest-day span of its reset. */
  restDayGrace?: boolean;
}

export interface AccountRow {
  id: string;
  /** The label, or the CLI login's name for `default`; in the owner's view, its private name for its mood. */
  name: string;
  /** Other names a switch by name finds it by: the label, and in the owner's view all private names. */
  aliases?: string[];
  /** Position in the preference order: 0 is the main account. */
  index: number;
  /** New runs go to this account (▶). */
  next: boolean;
  /** Some run on this account reported its quota. */
  known: boolean;
  windows: Record<WindowKind, AccountWindowView>;
  refusedUntil?: number;
  pastLine?: WindowKind;
  /** Below all its lines and not refused: a run would use it right now. */
  ready: boolean;
  /** Its lines are raised for now by a switch by name. */
  boosted: boolean;
  /** 0–1, see {@link switchScore}. */
  score: number;
}

/**
 * How good a switch target an account is, 0–1, built so that no weekly quota
 * is left unused at a reset — the weekly room that expires first is spent
 * first (owner's ask, 2026-11-03: an account two days from its reset with
 * half its week left lost to one six days out with more room):
 *
 *   0.60 × weekResetSoon × worth + 0.15 × weekRoom + 0.25 × fiveHourRoom
 *
 * - weekResetSoon = 1 − time to the weekly reset ÷ 7 days, the heaviest term:
 *   room left at a reset is gone for good, while room that resets later can
 *   still be used after; so whichever week ends first goes first (earliest
 *   deadline first, the order that leaves the least unused whatever the
 *   demand), as long as it has room. How much room it has does not change
 *   that order — the accounts that reset later get their turn afterwards;
 * - worth = min(1, weekRoom ÷ {@link WORTH_MOVING_ROOM}): with less than a
 *   tenth of its line left, an account's near reset counts for less, the few
 *   points are not worth a move;
 * - weekRoom = 1 − weekly used ÷ weekly line: of weeks ending about the same
 *   time, the one with more left;
 * - fiveHourRoom = 1 − 5-hour used ÷ 5-hour line: don't move to an account
 *   that is about to hit its 5-hour line and move again. Near the 5-hour
 *   reset ({@link graceMs}) it rises towards 1 (by 1 − time to the reset ÷
 *   that span): what is left comes back in full at the reset, so an account
 *   about to reset is as good as an empty one.
 *
 * Room is measured against the account's switch lines (opened up to
 * {@link GRACE_LINE} for a window about to reset), and an account
 * at or past either line scores 0: it is not a switch target until that
 * window resets. All clamped to 0–1. An account that never ran here counts as
 * half full with no reset known, so a proven account with room comes first.
 */
export function switchScore(windows: Record<WindowKind, AccountWindowView>, known: boolean, now = Date.now()): number {
  const room = (kind: WindowKind): number =>
    known ? clamp01(1 - (windows[kind].usedPercent ?? 0) / windows[kind].line) : UNKNOWN_ROOM;
  if (WINDOW_KINDS.some((kind) => room(kind) === 0)) return 0;
  const soon = (kind: WindowKind, span: number): number => {
    const left = windows[kind].resetsInMs;
    return !known || left === undefined ? 0 : clamp01(1 - left / span);
  };
  const weekRoom = room('seven_day');
  const fiveHourRoom = room('five_hour');
  // A rest day's weekly near-reset span: whatever is left goes at the reset
  // and its owner is not using it, so it is the first to use, few points or many.
  const weekGrace = known && windows.seven_day.restDayGrace === true;
  const worth = weekGrace ? 1 : Math.min(1, weekRoom / WORTH_MOVING_ROOM);
  const weekSoon = weekGrace ? 1 : soon('seven_day', WEEK_MS);
  const fiveHourSpan = windows.five_hour.graceSpanMs ?? graceMs('five_hour', now);
  return (
    SWITCH_SCORE_WEIGHTS.weekExpiring * weekSoon * worth +
    SWITCH_SCORE_WEIGHTS.weekRoom * weekRoom +
    SWITCH_SCORE_WEIGHTS.fiveHourRoom * (fiveHourRoom + (1 - fiveHourRoom) * soon('five_hour', fiveHourSpan))
  );
}

/** Some run on the account reported one of its windows. */
export function windowsKnown(windows: Record<WindowKind, AccountWindowView>): boolean {
  return WINDOW_KINDS.some((kind) => windows[kind].usedPercent !== undefined);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `line` under a run's cap for that window, if any; a cap never raises a line. */
export function withCap(line: number, kind: WindowKind, cap: LineCap | undefined): number {
  const ceiling = cap?.[kind];
  return ceiling !== undefined ? Math.min(line, ceiling) : line;
}
