import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getSecret } from '../../config/keystore';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import type { AgentEvent } from '../types';
import type { QuotaReading, QuotaWindow } from '../quota-window';
import { isOffDay, refreshHolidays } from './off-days';
import { defaultAccountsConfig, readAccountsConfig } from './accounts-config';
import { type AccountQuotaState, type ClaudeAccountEntry, type ClaudeAccountsConfig, type ClaudeAccountsPaths, DEFAULT_ACCOUNT_ID, GRACE_LINE, type LineCap, type PickedAccount, type SwitchLines, UNKNOWN_RESET_MS, WINDOW_KINDS, WINDOW_LABELS, type WindowKind, accountSecretId, claudeAccountsPaths, graceMs, isPausedEntry } from './accounts-model';
import { switchToAccount, withMain } from './accounts-config';
import { type AccountWindowView, STICKY_MARGIN, switchScore, windowsKnown, withCap } from './accounts-score';

export interface ClaudeAccountPoolOptions {
  paths: ClaudeAccountsPaths;
  now?: () => number;
  /** Decrypt one token. Injected in tests. */
  readSecret?: (id: string) => Promise<string | undefined>;
  /** `now` is a rest day ({@link ClaudeAccountsConfig.offDayLines}). Injected in tests; else `off-days.ts`. */
  isOffDay?: (now: number) => boolean;
}

type RateLimitEvent = Extract<AgentEvent, { type: 'rate_limit' }>;

export class ClaudeAccountPool {
  private config: ClaudeAccountsConfig = defaultAccountsConfig();
  private configStamp: number | undefined;
  private tokens = new Map<string, string>();
  private state: Record<string, AccountQuotaState> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly readSecret: (id: string) => Promise<string | undefined>;
  private readonly holidaysDir: string;
  private readonly offDay: (now: number) => boolean;

  constructor(private readonly opts: ClaudeAccountPoolOptions) {
    this.now = opts.now ?? Date.now;
    this.readSecret = opts.readSecret ?? ((id) => getSecret(id, opts.paths.keystore));
    this.holidaysDir = join(dirname(opts.paths.configFile), 'holidays');
    this.offDay = opts.isOffDay ?? ((now) => isOffDay(now, this.holidaysDir));
  }

  /** Re-read the account list when its file changed and decrypt the tokens. Never throws. */
  async refresh(): Promise<void> {
    this.loadState();
    if ((this.config.offDayLines || this.config.offDayGraceHours) && !this.opts.isOffDay) refreshHolidays(this.holidaysDir, this.now());
    let stamp = 0;
    try {
      stamp = statSync(this.opts.paths.configFile).mtimeMs;
    } catch {
      // No file: only the CLI's own login.
    }
    if (stamp === this.configStamp) return;
    const config = stamp ? readAccountsConfig(this.opts.paths) : defaultAccountsConfig();
    const tokens = new Map<string, string>();
    for (const account of config.accounts) {
      if (account.id === DEFAULT_ACCOUNT_ID) continue;
      const token = await this.readSecret(accountSecretId(account.id)).catch((err: unknown) => {
        log.warn('claude-accounts', 'token-unreadable', { id: account.id, err: String(err) });
        return undefined;
      });
      if (token) tokens.set(account.id, token);
      else log.warn('claude-accounts', 'token-missing', { id: account.id });
    }
    this.config = config;
    this.tokens = tokens;
    this.configStamp = stamp;
  }

  /** The 5-hour windows are kept staggered (see `window-stagger.ts`); on unless the owner turned it off. */
  get staggerEnabled(): boolean {
    return this.config.stagger !== false;
  }

  /** When the account's 5-hour window resets by the last reading (epoch ms, possibly past); undefined when never read. */
  fiveHourResetsAt(id: string): number | undefined {
    return this.loadState()[id]?.windows.five_hour?.resetsAt;
  }

  /**
   * A token account whose 5-hour window has run out waits for the stagger to
   * open its next one at its slot: a quota probe on a token is a model request
   * and would open the window right away — on `/accounts`, every idle account
   * in the same minute, which is how their resets bunched up. The CLI's own
   * login reads `/usage`, which opens nothing, so it is never held.
   */
  heldForStagger(id: string, now = this.now()): boolean {
    if (!this.staggerEnabled || !this.multi || id === DEFAULT_ACCOUNT_ID || !this.tokens.has(id)) return false;
    const resetsAt = this.fiveHourResetsAt(id);
    return resetsAt !== undefined && resetsAt <= now;
  }

  /** The profile's lines (accounts without their own follow these). */
  get defaultLines(): SwitchLines {
    return { ...this.config.lines };
  }

  /** The rest-day lines, if the owner set any. */
  get offDayLines(): Partial<SwitchLines> | undefined {
    return this.config.offDayLines ? { ...this.config.offDayLines } : undefined;
  }

  /** The rest-day near-reset spans in hours, if the owner set any. */
  get offDayGraceHours(): Partial<Record<WindowKind, number>> | undefined {
    return this.config.offDayGraceHours ? { ...this.config.offDayGraceHours } : undefined;
  }

  /** `now` is a rest day and rest-day lines or spans are set: they are in force. */
  offDayLinesActive(now = this.now()): boolean {
    return (this.config.offDayLines !== undefined || this.config.offDayGraceHours !== undefined) && this.offDay(now);
  }

  /** The rest-day span of `kind` in ms when it is in force at `now` and longer than the usual one. */
  private offDayGraceMs(kind: WindowKind, now: number): number | undefined {
    const hours = this.config.offDayGraceHours?.[kind];
    if (hours === undefined) return undefined;
    const ms = hours * 3_600_000;
    return ms > graceMs(kind, now) && this.offDay(now) ? ms : undefined;
  }

  /** How close to its reset `kind`'s window counts as about to reset at `now`: {@link graceMs}, longer on rest days. */
  graceSpanMs(kind: WindowKind, now = this.now()): number {
    return this.offDayGraceMs(kind, now) ?? graceMs(kind, now);
  }

  /** The line (1–100) at which runs leave the account in `kind`'s window, a raised one included, under `cap`. */
  lineOf(id: string, kind: WindowKind, now = this.now(), cap?: LineCap): number {
    const own = this.ownLineOf(id, kind, now);
    return withCap(this.inGrace(id, kind, now) ? Math.max(own, GRACE_LINE) : own, kind, cap);
  }

  /** The line before any near-reset opening: the account's own, raised by a switch by name. */
  private ownLineOf(id: string, kind: WindowKind, now: number): number {
    const base = this.baseLineOf(id, kind, now);
    const boost = this.config.accounts.find((a) => a.id === id)?.boost?.[kind];
    return boost && boost.until > now ? Math.max(base, boost.line) : base;
  }

  /** The window resets within {@link graceMs}: its line is open up to {@link GRACE_LINE}. */
  inGrace(id: string, kind: WindowKind, now = this.now()): boolean {
    const resetsAt = this.loadState()[id]?.windows[kind]?.resetsAt;
    return resetsAt !== undefined && resetsAt > now && resetsAt - now < this.graceSpanMs(kind, now);
  }

  /** The account's own line, or the profile's, raised to the rest-day line on rest days; no other raise. */
  baseLineOf(id: string, kind: WindowKind, now = this.now()): number {
    const line = this.config.accounts.find((a) => a.id === id)?.lines?.[kind] ?? this.config.lines[kind];
    const offDay = this.config.offDayLines?.[kind];
    return offDay !== undefined && offDay > line && this.offDay(now) ? offDay : line;
  }

  /** Some window's line is raised right now (a switch by name). */
  isBoosted(id: string, now = this.now()): boolean {
    return WINDOW_KINDS.some((kind) => this.ownLineOf(id, kind, now) > this.baseLineOf(id, kind, now));
  }

  /**
   * Accounts that can run, in order of preference: the CLI's own login and
   * those with a token, less any the owner paused.
   */
  accounts(): PickedAccount[] {
    const now = this.now();
    return this.config.accounts
      .filter((a) => a.id === DEFAULT_ACCOUNT_ID || this.tokens.has(a.id))
      .filter((a) => !isPausedEntry(a, now))
      .map((a) => this.toPicked(a));
  }

  /** Accounts the owner paused, with until when, in order of preference. */
  pausedAccounts(): Array<{ account: PickedAccount; until: number }> {
    const now = this.now();
    return this.config.accounts
      .filter((a) => isPausedEntry(a, now))
      .map((a) => ({ account: this.toPicked(a), until: a.pausedUntil! }));
  }

  /** The owner paused the account and the pause has not ended. */
  isPaused(id: string, now = this.now()): boolean {
    const entry = this.config.accounts.find((a) => a.id === id);
    return entry !== undefined && isPausedEntry(entry, now);
  }

  /**
   * Runs go through account tokens rather than the CLI's own login alone:
   * more than one account to choose from, or the CLI login paused so the one
   * left is a backup.
   */
  get multi(): boolean {
    const accounts = this.accounts();
    return accounts.length > 1 || (accounts.length === 1 && accounts[0]!.id !== DEFAULT_ACCOUNT_ID);
  }

  /**
   * The account a new run should use (see the rounds in the module comment):
   * below its lines, else not refused, else the one whose refusal ends first —
   * tried anyway, the refusal may be over (the run pauses if it is not).
   */
  pick(exclude?: ReadonlySet<string>, cap?: LineCap): PickedAccount | undefined {
    const now = this.now();
    return (
      this.pickRunnable(exclude, cap) ??
      this.accounts()
        .filter((a) => !exclude?.has(a.id))
        .sort((a, b) => (this.refusedUntil(a.id, now) ?? now) - (this.refusedUntil(b.id, now) ?? now))[0]
    );
  }

  /** Round 1, else round 2: never an account that is still refused. */
  pickRunnable(exclude?: ReadonlySet<string>, cap?: LineCap): PickedAccount | undefined {
    const now = this.now();
    return this.pickReady(exclude, cap) ?? this.choose(exclude, (id) => !this.isRefused(id, now), now, cap);
  }

  /** Round 1 only: an account below all its lines (under `cap`). */
  pickReady(exclude?: ReadonlySet<string>, cap?: LineCap): PickedAccount | undefined {
    const now = this.now();
    return this.choose(exclude, (id) => this.underLinesAt(id, now, cap) <= now, now, cap);
  }

  /**
   * Of the accounts `ok` lets through: the best switch score, ties keeping the
   * list's order — except that the main one stays while no other beats it by
   * more than {@link STICKY_MARGIN}.
   */
  private choose(
    exclude: ReadonlySet<string> | undefined,
    ok: (id: string) => boolean,
    now: number,
    cap?: LineCap,
  ): PickedAccount | undefined {
    const all = this.accounts();
    const candidates = all.filter((a) => !exclude?.has(a.id) && ok(a.id));
    let best: PickedAccount | undefined;
    let bestScore = -1;
    for (const account of candidates) {
      const score = this.score(account.id, now, cap);
      if (score > bestScore) {
        best = account;
        bestScore = score;
      }
    }
    const main = candidates[0] && candidates[0].id === all[0]?.id ? candidates[0] : undefined;
    if (main && best && best.id !== main.id && bestScore - this.score(main.id, now, cap) <= STICKY_MARGIN) return main;
    return best;
  }

  /** When a run or `/usage` last reported the account's quota (epoch ms); undefined when never. */
  reportedAt(id: string): number | undefined {
    return this.loadState()[id]?.updatedAt;
  }

  /**
   * Put `id` at the top of the list once a run moved to it, so new runs stay
   * on it until it reaches a line too; raised lines end with the move. Takes
   * effect at once; the file follows.
   */
  promote(id: string): void {
    const accounts = this.config.accounts;
    const entry = accounts.find((a) => a.id === id);
    if (!entry || accounts[0]?.id === id) return;
    this.config = { ...this.config, accounts: withMain(accounts, id) };
    log.info('claude-accounts', 'promote', { id });
    this.writing = this.writing
      .then(() => switchToAccount(this.opts.paths, id))
      .then(() => undefined)
      .catch((err: unknown) => log.warn('claude-accounts', 'promote-write-failed', { id, err: String(err) }));
  }

  /** Each window as the switch score and `/accounts` read it. */
  windowViews(id: string, now = this.now(), cap?: LineCap): Record<WindowKind, AccountWindowView> {
    const state = this.loadState()[id];
    const windows = {} as Record<WindowKind, AccountWindowView>;
    for (const kind of WINDOW_KINDS) {
      const window = state?.windows[kind];
      const line = this.lineOf(id, kind, now, cap);
      if (!window) {
        windows[kind] = { line };
        continue;
      }
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      const own = withCap(this.ownLineOf(id, kind, now), kind, cap);
      const restDaySpan = this.offDayGraceMs(kind, now);
      windows[kind] = {
        line,
        usedPercent: reset ? 0 : window.usedPercent,
        ...(reset ? { reset: true } : window.resetsAt !== undefined ? { resetsInMs: window.resetsAt - now } : {}),
        ...(line > own ? { graceFrom: own } : {}),
        ...(restDaySpan !== undefined ? { graceSpanMs: restDaySpan } : {}),
        ...(restDaySpan !== undefined && !reset && this.inGrace(id, kind, now) ? { restDayGrace: true } : {}),
      };
    }
    return windows;
  }

  /** The account's switch score, 0–1 ({@link switchScore}). */
  score(id: string, now = this.now(), cap?: LineCap): number {
    const windows = this.windowViews(id, now, cap);
    return switchScore(windows, windowsKnown(windows), now);
  }

  /** The account is below all its lines (under `cap`) and not refused right now. */
  hasRoom(id: string, cap?: LineCap): boolean {
    const now = this.now();
    return this.underLinesAt(id, now, cap) <= now;
  }

  /** A request on the account was refused and its window has not reset yet. */
  isRefused(id: string, now = this.now()): boolean {
    return this.refusedUntil(id, now) !== undefined;
  }

  /** When the account's refusal ends; undefined when it is not refused. */
  refusedUntil(id: string, now = this.now()): number | undefined {
    const until = this.loadState()[id]?.blockedUntil;
    return until !== undefined && until > now ? until : undefined;
  }

  /** When the first account stops being refused; undefined when one is not refused now. */
  nextRunnableAt(): number | undefined {
    const now = this.now();
    let soonest: number | undefined;
    for (const account of this.accounts()) {
      const until = this.refusedUntil(account.id, now);
      if (until === undefined) return undefined;
      soonest = soonest === undefined ? until : Math.min(soonest, until);
    }
    return soonest;
  }

  /** The first window the account is at or past its line in, with that line. */
  pastLine(id: string, now = this.now(), cap?: LineCap): { kind: WindowKind; line: number } | undefined {
    const state = this.loadState()[id];
    if (!state) return undefined;
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      const line = this.lineOf(id, kind, now, cap);
      if (!window || window.usedPercent < line) continue;
      const until = window.resetsAt ?? state.updatedAt + UNKNOWN_RESET_MS;
      if (until > now) return { kind, line };
    }
    return undefined;
  }

  /** When the account is below all its lines and not refused: now, or the reset that gets it there. */
  underLinesAt(id: string, now = this.now(), cap?: LineCap): number {
    const state = this.loadState()[id];
    if (!state) return now;
    let at = this.refusedUntil(id, now) ?? now;
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      if (!window || window.usedPercent < this.lineOf(id, kind, now, cap)) continue;
      const until = window.resetsAt ?? state.updatedAt + UNKNOWN_RESET_MS;
      if (until > at) at = until;
    }
    return at;
  }

  /**
   * Record a fresh `/usage` reading of `id` (windows by kind, reset as epoch
   * ms). Leaves a refusal alone: `/usage` does not say whether requests go
   * through.
   */
  observeUsage(id: string, windows: Partial<Record<WindowKind, { usedPercent: number; resetsAt?: number }>>): void {
    const kinds = WINDOW_KINDS.filter((kind) => windows[kind] !== undefined);
    if (kinds.length === 0) return;
    const now = this.now();
    const all = this.loadState();
    const state: AccountQuotaState = all[id] ?? { windows: {}, updatedAt: now };
    for (const kind of kinds) {
      const window = windows[kind]!;
      state.windows[kind] = {
        usedPercent: window.usedPercent,
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      };
    }
    state.updatedAt = now;
    all[id] = state;
    this.persist();
  }

  /** Record a model-specific window of `id` (e.g. {@link FABLE_WINDOW}); account picks ignore it. */
  observeModelWindow(id: string, kind: string, window: { usedPercent: number; resetsAt?: number }): void {
    const now = this.now();
    const all = this.loadState();
    const state: AccountQuotaState = all[id] ?? { windows: {}, updatedAt: now };
    state.windows[kind] = {
      usedPercent: window.usedPercent,
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    };
    all[id] = state;
    this.persist();
  }

  /** How full `kind` of `id` is by the last reading (0 once its reset passed); undefined when never read. */
  windowUsed(id: string, kind: string, now = this.now()): number | undefined {
    const window = this.loadState()[id]?.windows[kind];
    if (!window) return undefined;
    return window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;
  }

  /** Record what a run on `id` reported about its quota. */
  observe(id: string, evt: RateLimitEvent): void {
    const now = this.now();
    const all = this.loadState();
    const state: AccountQuotaState = all[id] ?? { windows: {}, updatedAt: now };
    for (const window of evt.windows ?? []) {
      state.windows[window.kind] = {
        usedPercent: window.usedPercent,
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      };
    }
    if (evt.blocked) {
      // The refusal message itself carries no reset; keep the one the
      // rate_limit_event before it gave.
      const stillBlocked = state.blockedUntil !== undefined && state.blockedUntil > now;
      state.blockedUntil = evt.resetsAt ?? (stillBlocked ? state.blockedUntil : now + UNKNOWN_RESET_MS);
    } else {
      delete state.blockedUntil;
    }
    state.updatedAt = now;
    all[id] = state;
    this.persist();
  }

  /** What the account's runs last said about its quota, as a quota reading. Undefined when they never said. */
  quotaReading(id: string, now = this.now()): QuotaReading | undefined {
    const state = this.loadState()[id];
    if (!state) return undefined;
    const windows: QuotaWindow[] = [];
    for (const kind of WINDOW_KINDS) {
      const window = state.windows[kind];
      if (!window) continue;
      const reset = window.resetsAt !== undefined && window.resetsAt <= now;
      windows.push({
        label: WINDOW_LABELS[kind],
        usedPercent: reset ? 0 : window.usedPercent,
        ...(window.resetsAt !== undefined && !reset ? { resets: new Date(window.resetsAt).toISOString() } : {}),
      });
    }
    const blocked = this.isRefused(id, now);
    if (windows.length === 0 && !blocked) return undefined;
    return { windows, ...(blocked ? { blocked: true } : {}) };
  }

  /** Each account with its last known quota, for status displays. */
  status(): Array<{ account: PickedAccount; state?: AccountQuotaState }> {
    const all = this.loadState();
    return this.accounts().map((account) => ({ account, ...(all[account.id] ? { state: all[account.id] } : {}) }));
  }

  /** Wait for pending state writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writing;
  }

  private toPicked(entry: ClaudeAccountEntry): PickedAccount {
    const token = this.tokens.get(entry.id);
    return {
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.nicknames ? { nicknames: entry.nicknames } : {}),
      env: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {},
    };
  }

  private loadState(): Record<string, AccountQuotaState> {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(readFileSync(this.opts.paths.stateFile, 'utf8')) as { accounts?: unknown };
      this.state =
        raw.accounts && typeof raw.accounts === 'object' ? (raw.accounts as Record<string, AccountQuotaState>) : {};
    } catch {
      this.state = {};
    }
    return this.state;
  }

  private persist(): void {
    const body = `${JSON.stringify({ accounts: this.loadState() }, null, 2)}\n`;
    this.writing = this.writing
      .then(() => writeFileAtomic(this.opts.paths.stateFile, body, { mode: 0o600 }))
      .catch((err: unknown) => log.warn('claude-accounts', 'state-write-failed', { err: String(err) }));
  }
}

const pools = new Map<string, ClaudeAccountPool>();

/** The one pool per profile directory, shared by the adapter, quota reads and the Sponsor lookup. */
export function claudeAccountPool(profileDir: string): ClaudeAccountPool {
  const key = resolve(profileDir);
  let pool = pools.get(key);
  if (!pool) {
    pool = new ClaudeAccountPool({ paths: claudeAccountsPaths(key) });
    pools.set(key, pool);
  }
  return pool;
}
