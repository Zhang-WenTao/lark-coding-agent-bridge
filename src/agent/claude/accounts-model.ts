import { join } from 'node:path';
import { type KeystorePaths } from '../../config/keystore';

export const DEFAULT_ACCOUNT_ID = 'default';
/** How long a refusal benches an account when the CLI did not say when it resets. */
export const UNKNOWN_RESET_MS = 60 * 60_000;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** The windows that limit every model; model-specific weekly windows only count when they refuse. */
export type WindowKind = 'five_hour' | 'seven_day';
export const WINDOW_KINDS: readonly WindowKind[] = ['five_hour', 'seven_day'];
export const WINDOW_LABELS: Record<WindowKind, string> = { five_hour: '5 小时窗口', seven_day: '本周' };
/**
 * Fable's own weekly window (`/usage`: "Current week (Fable)"). It limits Fable
 * runs only, so it stays out of account picks; 自动分级 reads it before climbing to Fable.
 */
export const FABLE_WINDOW = 'seven_day_fable';

/** Fill (1–100%) per window at which runs move to another account. */
export type SwitchLines = Record<WindowKind, number>;

/**
 * A ceiling one run puts on every account's lines (课堂精练 stops using an
 * account at 80% even where chats go on to 98%). A window left out keeps the
 * account's own line; a cap never raises one.
 */
export type LineCap = Partial<Record<WindowKind, number>>;
export const DEFAULT_LINES: SwitchLines = { five_hour: 98, seven_day: 98 };
/**
 * The line a window about to reset ({@link graceMs}) opens up to. What an
 * account's own line keeps back is lost at the reset if nobody uses it, so
 * runs may go past the line until then; a run's cap ({@link LineCap}) still
 * holds.
 */
export const GRACE_LINE = 98;
/**
 * How close to its reset a window counts as about to reset, by the hour of
 * day on the bridge's clock (owner's choice, 2026-10-30; the week's daytime
 * span 2 → 4 hours on 2026-11-06): shorter in the
 * daytime, when the accounts' owners may still want what their line keeps
 * back. `day` is [from, to) in hours.
 */
export const GRACE_SPANS: Record<WindowKind, { day: readonly [number, number]; dayMs: number; otherMs: number }> = {
  five_hour: { day: [8, 21], dayMs: 30 * 60_000, otherMs: 3_600_000 },
  seven_day: { day: [8, 20], dayMs: 4 * 3_600_000, otherMs: 6 * 3_600_000 },
};

/** The near-reset span of `kind` at `now` ({@link GRACE_SPANS}). */
export function graceMs(kind: WindowKind, now: number): number {
  const { day, dayMs, otherMs } = GRACE_SPANS[kind];
  const hour = new Date(now).getHours();
  return hour >= day[0] && hour < day[1] ? dayMs : otherMs;
}

/** A raised line and until when it holds (that window's next reset). */
export interface LineBoost {
  line: number;
  until: number;
}

export interface ClaudeAccountEntry {
  id: string;
  /** Shown on the reply card's `Sponsor:` line. The CLI's own login reads its name from `claude auth status`. */
  label?: string;
  /** This account's own lines; a window left out follows the profile's. */
  lines?: Partial<SwitchLines>;
  /**
   * Lines raised by a switch by name, per window, until that window resets.
   * Dropped as soon as runs move on to another account.
   */
  boost?: Partial<Record<WindowKind, LineBoost>>;
  /** Paused by the owner: no run uses the account until then (epoch ms); it comes back on its own. */
  pausedUntil?: number;
  /**
   * The owner's private names for the account, one per mood ({@link nicknameOf}).
   * Shown only where only the owner sees it — `/accounts`, `/accounts switch`
   * and `/usage` in the owner's own DM, and the local CLI; everywhere else,
   * including the reply card's `Sponsor:` line, keeps `label`.
   */
  nicknames?: Nicknames;
}

/**
 * The moods an account's private name follows, read off its state: `excited`
 * while new runs use it, `happy` when it is ready, `wronged` once past a line
 * (no fault of its own — it waits for the others), `sad` when refused or paused.
 */
export const NICKNAME_MOODS = ['happy', 'excited', 'sad', 'wronged'] as const;
export type NicknameMood = (typeof NICKNAME_MOODS)[number];
export type Nicknames = Partial<Record<NicknameMood, string>>;

/** `高兴` / `happy` → `happy`; undefined for anything else. */
export function parseNicknameMood(raw: string): NicknameMood | undefined {
  const key = raw.trim().toLowerCase();
  const zh: Record<string, NicknameMood> = { 高兴: 'happy', 兴奋: 'excited', 难过: 'sad', 委屈: 'wronged' };
  return (NICKNAME_MOODS as readonly string[]).includes(key) ? (key as NicknameMood) : zh[key];
}

/**
 * The account's private name for a mood; falls back through the other moods
 * (happy first) so one name is enough. Undefined when it has none.
 */
export function nicknameOf(entry: Pick<ClaudeAccountEntry, 'nicknames'>, mood: NicknameMood): string | undefined {
  const names = entry.nicknames;
  if (!names) return undefined;
  return names[mood] ?? names.happy ?? NICKNAME_MOODS.map((m) => names[m]).find(Boolean);
}

/** How a listing names accounts: `private` only for the owner's own eyes. */
export interface AccountNameView {
  /** Use the owner's private names ({@link ClaudeAccountEntry.nicknames}) where set. */
  private?: boolean;
}

export function parseNicknames(raw: unknown): Nicknames | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Nicknames = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const mood = parseNicknameMood(key);
    if (mood && typeof value === 'string' && value.trim()) out[mood] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ClaudeAccountsConfig {
  lines: SwitchLines;
  /**
   * On rest days (weekends and statutory holidays, `off-days.ts`) every
   * account's line in a window listed here is raised to it (never lowered).
   */
  offDayLines?: Partial<SwitchLines>;
  /**
   * On rest days a window counts as about to reset ({@link GRACE_LINE}) this
   * many hours before its reset, where longer than {@link GRACE_SPANS}; a
   * weekly window in it also scores as the first to use ({@link switchScore}).
   * Owner's choice 2026-11-08: 5-hour 5 (the whole window), weekly 24.
   */
  offDayGraceHours?: Partial<Record<WindowKind, number>>;
  /** Preference order; `default` is always present. */
  accounts: ClaudeAccountEntry[];
  /**
   * `false`: leave the 5-hour windows where runs open them. Otherwise they are
   * kept evenly staggered (see `window-stagger.ts`).
   */
  stagger?: false;
}

export interface AccountQuotaWindow {
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms. */
  resetsAt?: number;
}

export interface AccountQuotaState {
  /** By Claude's window name: `five_hour`, `seven_day`, … */
  windows: Record<string, AccountQuotaWindow>;
  /** A request was refused for quota: the account sits out until then (epoch ms). */
  blockedUntil?: number;
  /** Epoch ms of the last report. */
  updatedAt: number;
}

export interface PickedAccount {
  id: string;
  label?: string;
  /** The owner's private names by mood; see {@link ClaudeAccountEntry.nicknames}. */
  nicknames?: Nicknames;
  /** Extra environment for the claude process: the account's token. Empty for the CLI's own login. */
  env: Record<string, string>;
}

export interface ClaudeAccountsPaths {
  configFile: string;
  stateFile: string;
  keystore: KeystorePaths;
}

export function claudeAccountsPaths(profileDir: string): ClaudeAccountsPaths {
  return {
    configFile: join(profileDir, 'claude-accounts.json'),
    stateFile: join(profileDir, 'claude-accounts-state.json'),
    keystore: { secretsFile: join(profileDir, 'secrets.enc'), keystoreSaltFile: join(profileDir, '.keystore.salt') },
  };
}

export function accountSecretId(id: string): string {
  return `claude-oauth-${id}`;
}

export function isValidAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

export function isValidLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100;
}

export function isPausedEntry(entry: ClaudeAccountEntry, now: number): boolean {
  return entry.pausedUntil !== undefined && entry.pausedUntil > now;
}
