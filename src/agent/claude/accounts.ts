/**
 * Several Claude subscription accounts behind one profile, so a run can move
 * to another account when the current one is full.
 *
 * Only the credential differs between accounts: an extra account is a
 * long-lived token from `claude setup-token`, handed to the claude process as
 * `CLAUDE_CODE_OAUTH_TOKEN`. Everything else — the config directory, the
 * session transcripts `--resume` reads, settings, skills — stays the CLI's
 * own, so a conversation carries on across accounts. `default` is the CLI's
 * own login and is always on the list.
 *
 * Which account a run gets, in rounds:
 *   1. of the accounts still below their switch lines (one per window:
 *      5-hour and weekly; per account or the profile's default): the one with
 *      the best switch score ({@link switchScore}), checked again before every
 *      run; the main one (first on the list) keeps the run unless another
 *      beats it by more than {@link STICKY_MARGIN}, since every move re-reads
 *      the whole conversation uncached (the prompt cache is per account);
 *   2. once every account is past a line: of those not refused, the same
 *      way — accounts are used up one after another;
 *   3. once every account has been refused: the run waits for the soonest
 *      reset (it pauses and resumes on its own).
 * The account a run moves to becomes the main one (top of the list). An
 * account paused by the owner (`pausedUntil`) takes no part until then and
 * comes back on its own. A window about to reset ({@link graceMs}) has its
 * line opened up to {@link GRACE_LINE}: the room a line keeps back for the
 * account's owner comes back at the reset anyway, so runs may use it first.
 *
 * Files in the profile directory:
 *   - `claude-accounts.json`: the list, in order of preference, and the
 *     switch lines. Re-read whenever it changes, no restart needed.
 *   - `claude-accounts-state.json`: what each account's last run said about
 *     its quota (`rate_limit_event`), and until when a refusal benched it.
 *   - `account-scheduling-state.json`: 账户调度's learned 1% values, the
 *     accounts conversations last ran on, and scheduled jobs' recent costs
 *     ({@link AccountScheduler}).
 *   - the profile keystore (`secrets.enc`) holds the tokens, as
 *     `claude-oauth-<id>`.
 */

export { DEFAULT_ACCOUNT_ID, WINDOW_KINDS, WINDOW_LABELS, FABLE_WINDOW, DEFAULT_LINES, GRACE_LINE, GRACE_SPANS, graceMs, NICKNAME_MOODS, parseNicknameMood, nicknameOf, claudeAccountsPaths, accountSecretId, isValidAccountId, isValidLine } from './accounts-model';
export type { WindowKind, SwitchLines, LineCap, LineBoost, ClaudeAccountEntry, NicknameMood, Nicknames, AccountNameView, ClaudeAccountsConfig, AccountQuotaWindow, AccountQuotaState, PickedAccount, ClaudeAccountsPaths } from './accounts-model';
export { defaultAccountsConfig, parseAccountsConfig, readAccountsConfig, saveAccount, updateAccount, updateDefaultLines, updateOffDayLines, updateStagger, reorderAccounts, deleteAccount, switchToAccount } from './accounts-config';
export type { AccountChanges } from './accounts-config';
export { SWITCH_SCORE_WEIGHTS, WORTH_MOVING_ROOM, STICKY_MARGIN, switchScore } from './accounts-score';
export type { AccountWindowView, AccountRow } from './accounts-score';
export { ClaudeAccountPool, claudeAccountPool } from './accounts-pool';
export type { ClaudeAccountPoolOptions } from './accounts-pool';
export { AccountScheduler, DEFAULT_SCHEDULING_MODE, DEFAULT_MAX_BIG_LOAD, DEFAULT_USD_PER_PERCENT, parseSchedulingConfig } from './accounts-scheduling';
export type { SchedulingMode, SchedulingConfig, ScheduleChoice } from './accounts-scheduling';
export { accountsReport, offDayNote, pausedNote, findPausedAccount, pausedRefusal, accountRows, formatHoursMinutes, formatDaysHours, accountsTable, expiringFirstNote, bestSwitchTarget, findAccountRow, switchBoost, parseSwitchQuery, switchRefusal } from './accounts-report';
