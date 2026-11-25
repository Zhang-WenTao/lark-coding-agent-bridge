import { readFileSync } from 'node:fs';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../platform/atomic-write';
import { type LineCap, type PickedAccount, WINDOW_KINDS, type WindowKind } from './accounts-model';
import type { AccountWindowView } from './accounts-score';
import {
  DEFAULT_SIZE_RESERVE_USD,
  SIZE_DURATION_MS,
  SIZE_LOAD,
  TASK_SIZES,
  type TaskSize,
  costToSize,
  isBigSize,
} from './task-size';

/**
 * 账户调度 (owner's ask, 2026-11-25): pick accounts by how much a run is
 * likely to use and how far each account is from its own switch line, and
 * spread big runs over different accounts.
 *
 * - Every account's room is what is left below its own lines, in API dollars
 *   ({@link AccountScheduler.usdPerPercent}: what 1% of that window holds on
 *   that account), less what runs on it are still held to use (their
 *   reservations). No fixed "30% left" bar: accounts are compared by that room.
 * - A big run (L / XL) takes the account with the most room that has its
 *   reserve free and is under {@link DEFAULT_MAX_BIG_LOAD}; small runs keep
 *   the switch score, on accounts their reserve fits.
 * - Each run reserves its size's P90 on its account; what the account's usage
 *   rose by since counts against it, shared among the runs there. A second
 *   big run sees the first one's reservation and goes elsewhere; runs leaving
 *   one account together are placed one by one, each seeing the last.
 * - An account starts to empty before its line: its runs' next steps (each
 *   run's usage rise per report) and the reservations of runs that cannot
 *   move (background tasks, subagents in flight) count as already used.
 *
 * `mode`: `off` leaves picks alone; `shadow` (the default) logs what it would
 * pick and when it would move; `on` acts on it.
 */

export type SchedulingMode = 'off' | 'shadow' | 'on';

export interface SchedulingConfig {
  mode?: SchedulingMode;
  /** Overrides {@link DEFAULT_SIZE_RESERVE_USD}. */
  reserveUsd?: Partial<Record<TaskSize, number>>;
  /** Big-run load one account takes at most (L counts 1, XL 2); ignored when every account is full. */
  maxBigLoad?: number;
  /** What 1% of a window holds, until an account's own is learned. */
  usdPerPercent?: Partial<Record<WindowKind, number>>;
  /** Command prefixes that start big work, over the built-in ones. */
  bigCommands?: Record<string, TaskSize>;
}

export const DEFAULT_SCHEDULING_MODE: SchedulingMode = 'shadow';
export const DEFAULT_MAX_BIG_LOAD = 2;
/**
 * What 1% of a window held on the busiest account by 2026-11-25's state and
 * the bridge's own costs over the window (backup6: 5-hour ≈ $0.70, week ≈ $4.30).
 */
export const DEFAULT_USD_PER_PERCENT: Record<WindowKind, number> = { five_hour: 0.7, seven_day: 4 };
/** Learned values stay within this factor of the default (one owner's own use can skew a sample). */
const LEARN_CLAMP = 5;
const LEARN_ALPHA = 0.2;
/** Usage rises (in points) below this are too coarse to learn from. */
const LEARN_MIN_DELTA = 2;
/** Samples before an account's learned value replaces the default. */
const LEARN_MIN_SAMPLES = 5;
const STEP_ALPHA = 0.3;
/** Reports with resets this close apart belong to the same window. */
const SAME_WINDOW_MS = 60_000;
/** An account that never reported counts as half full. */
const UNKNOWN_USED_SHARE = 0.5;
/** Big runs this close in room (as a share of the run's reserve) go by the switch score. */
const ROOM_TIE_SHARE = 0.1;
const SESSION_TTL_MS = 3 * 86_400_000;
const JOB_HISTORY = 5;

export function parseSchedulingConfig(raw: unknown): SchedulingConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: SchedulingConfig = {};
  if (r.mode === 'off' || r.mode === 'shadow' || r.mode === 'on') out.mode = r.mode;
  const reserve = sizeNumbers(r.reserveUsd);
  if (reserve) out.reserveUsd = reserve;
  if (typeof r.maxBigLoad === 'number' && Number.isFinite(r.maxBigLoad) && r.maxBigLoad >= 1) out.maxBigLoad = r.maxBigLoad;
  if (r.usdPerPercent && typeof r.usdPerPercent === 'object') {
    const k: Partial<Record<WindowKind, number>> = {};
    for (const kind of WINDOW_KINDS) {
      const v = (r.usdPerPercent as Record<string, unknown>)[kind];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) k[kind] = v;
    }
    if (Object.keys(k).length > 0) out.usdPerPercent = k;
  }
  if (r.bigCommands && typeof r.bigCommands === 'object') {
    const cmds: Record<string, TaskSize> = {};
    for (const [name, size] of Object.entries(r.bigCommands as Record<string, unknown>)) {
      if (/^\/[\w:-]+$/.test(name) && (TASK_SIZES as readonly unknown[]).includes(size)) cmds[name.toLowerCase()] = size as TaskSize;
    }
    if (Object.keys(cmds).length > 0) out.bigCommands = cmds;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sizeNumbers(raw: unknown): Partial<Record<TaskSize, number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<TaskSize, number>> = {};
  for (const size of TASK_SIZES) {
    const v = (raw as Record<string, unknown>)[size];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[size] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What the scheduler reads off the pool. */
export interface SchedulerPoolView {
  accounts(): PickedAccount[];
  windowViews(id: string, now: number, cap?: LineCap): Record<WindowKind, AccountWindowView>;
  /** Below all its lines (under `cap`) and not refused at `now`. */
  readyAt(id: string, now: number, cap?: LineCap): boolean;
  score(id: string, now: number, cap?: LineCap): number;
}

interface WindowMark {
  used: number;
  resetsAt?: number;
}

interface Reservation {
  runId: string;
  account: string;
  size: TaskSize;
  reserveUsd: number;
  /** The account's usage per window when the run came (what it rose by since counts against the reservation). */
  base: Partial<Record<WindowKind, WindowMark>>;
  /** This run's last report per window, and its usage rise per report. */
  last: Partial<Record<WindowKind, WindowMark>>;
  step: Partial<Record<WindowKind, number>>;
  /** Background tasks or subagents in flight: the run cannot move now. */
  unmovable: boolean;
}

interface LearnedK {
  k: number;
  samples: number;
}

interface SchedulingState {
  k: Record<string, Partial<Record<WindowKind, LearnedK>>>;
  sessions: Record<string, { account: string; size: TaskSize; at: number }>;
  jobs: Record<string, number[]>;
}

export interface ScheduleChoice {
  /** The account a big run should take. */
  account?: string;
  /** Accounts a small run's reserve fits on (the switch score picks among them). */
  allowed?: Set<string>;
  why: string;
  rooms: Record<string, number>;
}

export interface AccountSchedulerOptions {
  /** Where the learned values, sessions and job history are kept. */
  stateFile: string;
  now: () => number;
  config: () => SchedulingConfig | undefined;
  pool: SchedulerPoolView;
}

export class AccountScheduler {
  private readonly reservations = new Map<string, Reservation>();
  private state: SchedulingState | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** Calibration: cost seen on an account since its last usable report, and that report, per window. */
  private readonly pendingUsd = new Map<string, Partial<Record<WindowKind, number>>>();
  private readonly lastSeen = new Map<string, Partial<Record<WindowKind, WindowMark>>>();
  private readonly logged = new Map<string, Partial<Record<WindowKind, number>>>();

  constructor(private readonly opts: AccountSchedulerOptions) {}

  get mode(): SchedulingMode {
    return this.opts.config()?.mode ?? DEFAULT_SCHEDULING_MODE;
  }

  get bigCommands(): Record<string, TaskSize> | undefined {
    return this.opts.config()?.bigCommands;
  }

  reserveOf(size: TaskSize): number {
    return this.opts.config()?.reserveUsd?.[size] ?? DEFAULT_SIZE_RESERVE_USD[size];
  }

  private get maxBigLoad(): number {
    return this.opts.config()?.maxBigLoad ?? DEFAULT_MAX_BIG_LOAD;
  }

  /** What 1% of `kind` holds on `id`: learned from its own runs once there are enough samples, else the default. */
  usdPerPercent(id: string, kind: WindowKind): number {
    const learned = this.load().k[id]?.[kind];
    if (learned && learned.samples >= LEARN_MIN_SAMPLES) return learned.k;
    return this.defaultK(kind);
  }

  private defaultK(kind: WindowKind): number {
    return this.opts.config()?.usdPerPercent?.[kind] ?? DEFAULT_USD_PER_PERCENT[kind];
  }

  // ─── Reservations ─────────────────────────────────────────────────────────

  reserve(runId: string, account: string, size: TaskSize, reserveUsd: number): void {
    this.reservations.set(runId, {
      runId,
      account,
      size,
      reserveUsd,
      base: this.marks(account),
      last: {},
      step: {},
      unmovable: false,
    });
  }

  update(runId: string, change: { size?: TaskSize; reserveUsd?: number; unmovable?: boolean }): void {
    const res = this.reservations.get(runId);
    if (!res) return;
    if (change.size) res.size = change.size;
    if (change.reserveUsd !== undefined) res.reserveUsd = change.reserveUsd;
    if (change.unmovable !== undefined) res.unmovable = change.unmovable;
  }

  /** The run moved: its reservation goes with it, counted from the new account's usage now. */
  move(runId: string, account: string): void {
    const res = this.reservations.get(runId);
    if (!res || res.account === account) return;
    res.account = account;
    res.base = this.marks(account);
    res.last = {};
    res.step = {};
  }

  release(runId: string): void {
    this.reservations.delete(runId);
  }

  reservationOf(runId: string): { account: string; size: TaskSize; reserveUsd: number } | undefined {
    const res = this.reservations.get(runId);
    return res ? { account: res.account, size: res.size, reserveUsd: res.reserveUsd } : undefined;
  }

  private onAccount(id: string): Reservation[] {
    return [...this.reservations.values()].filter((r) => r.account === id);
  }

  /** Big-run load on the account (L 1, XL 2). */
  bigLoad(id: string, excludeRun?: string): number {
    return this.onAccount(id).reduce((sum, r) => sum + (r.runId === excludeRun ? 0 : SIZE_LOAD[r.size]), 0);
  }

  private marks(account: string): Partial<Record<WindowKind, WindowMark>> {
    const views = this.opts.pool.windowViews(account, this.opts.now());
    const out: Partial<Record<WindowKind, WindowMark>> = {};
    for (const kind of WINDOW_KINDS) {
      const used = views[kind].usedPercent;
      if (used !== undefined) out[kind] = { used };
    }
    return out;
  }

  /** What a run is still held to use in `kind` on its account, in points of that window. */
  private remainingPct(res: Reservation, kind: WindowKind, used: number | undefined, share: number): number {
    const held = res.reserveUsd / this.usdPerPercent(res.account, kind);
    if (used === undefined) return held;
    const base = res.base[kind]?.used ?? used;
    // Below the base the window reset: all of its usage came after the run did.
    const rose = used >= base ? used - base : used;
    return Math.max(0, held - rose / share);
  }

  // ─── Room ─────────────────────────────────────────────────────────────────

  /**
   * Points left below the line in each window, less the reservations of the
   * account's runs (`excludeRun` left out). A window that resets within
   * `durationMs` counts what comes back for the rest of that time.
   */
  roomPct(id: string, now: number, opts: { cap?: LineCap; excludeRun?: string; durationMs?: number } = {}): Record<WindowKind, number> {
    const views = this.opts.pool.windowViews(id, now, opts.cap);
    const runs = this.onAccount(id);
    const share = Math.max(1, runs.length);
    const out = {} as Record<WindowKind, number>;
    for (const kind of WINDOW_KINDS) {
      const view = views[kind];
      const used = view.usedPercent ?? view.line * UNKNOWN_USED_SHARE;
      let room = view.line - used;
      for (const res of runs) {
        if (res.runId === opts.excludeRun) continue;
        room -= this.remainingPct(res, kind, view.usedPercent, share);
      }
      const left = view.resetsInMs;
      if (opts.durationMs !== undefined && left !== undefined && left < opts.durationMs) {
        room += view.line * (1 - left / opts.durationMs);
      }
      out[kind] = room;
    }
    return out;
  }

  /** {@link roomPct} in API dollars: the window with the least. */
  roomUsd(id: string, now: number, opts: { cap?: LineCap; excludeRun?: string; durationMs?: number } = {}): number {
    const pct = this.roomPct(id, now, opts);
    return Math.min(...WINDOW_KINDS.map((kind) => pct[kind] * this.usdPerPercent(id, kind)));
  }

  // ─── Decisions ────────────────────────────────────────────────────────────

  /**
   * Where a run of `size` holding `reserveUsd` should go. Undefined when no
   * account is ready (the pool's own rounds take over).
   */
  choose(
    size: TaskSize,
    reserveUsd: number,
    opts: { exclude?: ReadonlySet<string>; cap?: LineCap; runId?: string; sessionAccount?: string } = {},
  ): ScheduleChoice | undefined {
    const now = this.opts.now();
    const ready = this.opts.pool
      .accounts()
      .map((a) => a.id)
      .filter((id) => !opts.exclude?.has(id) && this.opts.pool.readyAt(id, now, opts.cap));
    if (ready.length === 0) return undefined;
    const durationMs = SIZE_DURATION_MS[size];
    const rooms: Record<string, number> = {};
    for (const id of ready) {
      rooms[id] = round2(this.roomUsd(id, now, { ...(opts.cap ? { cap: opts.cap } : {}), ...(opts.runId ? { excludeRun: opts.runId } : {}), durationMs }));
    }
    const fits = ready.filter((id) => rooms[id]! >= reserveUsd);
    if (opts.sessionAccount && fits.includes(opts.sessionAccount)) {
      const loadOk = !isBigSize(size) || this.bigLoad(opts.sessionAccount, opts.runId) + SIZE_LOAD[size] <= this.maxBigLoad;
      if (loadOk) return { account: opts.sessionAccount, allowed: new Set([opts.sessionAccount]), why: 'session', rooms };
    }
    if (!isBigSize(size)) {
      return fits.length > 0 ? { allowed: new Set(fits), why: 'fits', rooms } : { why: 'none-fits', rooms };
    }
    let pool = fits.filter((id) => this.bigLoad(id, opts.runId) + SIZE_LOAD[size] <= this.maxBigLoad);
    let why = 'most-room';
    if (pool.length === 0 && fits.length > 0) {
      pool = fits;
      why = 'load-full';
    }
    if (pool.length === 0) {
      pool = ready;
      why = 'none-fits';
    }
    const best = Math.max(...pool.map((id) => rooms[id]!));
    const near = pool.filter((id) => rooms[id]! >= best - ROOM_TIE_SHARE * reserveUsd);
    // Close in room: the week that ends first goes first, as the switch score has it.
    near.sort((a, b) => this.opts.pool.score(b, now, opts.cap) - this.opts.pool.score(a, now, opts.cap) || rooms[b]! - rooms[a]!);
    return { account: near[0]!, why, rooms };
  }

  /**
   * The account is about to reach a line once its runs' next steps and the
   * reservations of runs that cannot move (`runId` itself left out) are
   * counted: movable runs should leave now.
   */
  nearLine(id: string, runId: string, cap?: LineCap): boolean {
    const now = this.opts.now();
    const views = this.opts.pool.windowViews(id, now, cap);
    const runs = this.onAccount(id);
    const share = Math.max(1, runs.length);
    return WINDOW_KINDS.some((kind) => {
      const used = views[kind].usedPercent;
      if (used === undefined) return false;
      let ahead = 0;
      for (const res of runs) {
        ahead += res.step[kind] ?? 0;
        if (res.unmovable && res.runId !== runId) ahead += this.remainingPct(res, kind, used, share);
      }
      return used + ahead >= views[kind].line;
    });
  }

  /** What the run is still held to use, in dollars (its least-room window's view). */
  remainingUsd(runId: string): number {
    const res = this.reservations.get(runId);
    if (!res) return 0;
    const views = this.opts.pool.windowViews(res.account, this.opts.now());
    const share = Math.max(1, this.onAccount(res.account).length);
    // Only a reported window tells what was used since.
    const known = WINDOW_KINDS.filter((kind) => views[kind].usedPercent !== undefined);
    if (known.length === 0) return res.reserveUsd;
    return Math.max(
      ...known.map((kind) => this.remainingPct(res, kind, views[kind].usedPercent, share) * this.usdPerPercent(res.account, kind)),
    );
  }

  /** `to` has more room than `from` for the run (its own reservation left out of both). */
  moreRoom(to: string, from: string, runId: string): boolean {
    const now = this.opts.now();
    return this.roomUsd(to, now, { excludeRun: runId }) > this.roomUsd(from, now, { excludeRun: runId });
  }

  /** The run's own remaining reservation no longer fits on its account. */
  misfit(runId: string, cap?: LineCap): boolean {
    const res = this.reservations.get(runId);
    if (!res) return false;
    const pct = this.roomPct(res.account, this.opts.now(), { ...(cap ? { cap } : {}) });
    return WINDOW_KINDS.some((kind) => pct[kind] < 0);
  }

  // ─── Observations ─────────────────────────────────────────────────────────

  /** A run on `account` reported its windows: steps, calibration, the snapshot log. */
  noteQuota(account: string, windows: ReadonlyArray<{ kind: string; usedPercent: number; resetsAt?: number }>, runId?: string): void {
    const res = runId ? this.reservations.get(runId) : undefined;
    for (const w of windows) {
      if (!(WINDOW_KINDS as readonly string[]).includes(w.kind)) continue;
      const kind = w.kind as WindowKind;
      const mark: WindowMark = { used: w.usedPercent, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) };
      if (res && res.account === account) {
        const prev = res.last[kind];
        if (prev && sameWindow(prev, mark) && mark.used >= prev.used) {
          const delta = mark.used - prev.used;
          const before = res.step[kind];
          res.step[kind] = before === undefined ? delta : before + STEP_ALPHA * (delta - before);
        }
        res.last[kind] = mark;
      }
      this.learn(account, kind, mark);
      this.snapshot(account, kind, mark);
    }
  }

  /** A turn on `account` cost `usd`. */
  noteCost(account: string, usd: number): void {
    if (!(usd > 0)) return;
    const pending = this.pendingUsd.get(account) ?? {};
    for (const kind of WINDOW_KINDS) pending[kind] = (pending[kind] ?? 0) + usd;
    this.pendingUsd.set(account, pending);
  }

  private learn(account: string, kind: WindowKind, mark: WindowMark): void {
    const seen = this.lastSeen.get(account) ?? {};
    const prev = seen[kind];
    const pending = this.pendingUsd.get(account) ?? {};
    if (!prev || !sameWindow(prev, mark) || mark.used < prev.used) {
      seen[kind] = mark;
      pending[kind] = 0;
    } else if (mark.used - prev.used >= LEARN_MIN_DELTA) {
      const usd = pending[kind] ?? 0;
      if (usd > 0) {
        const fallback = this.defaultK(kind);
        const sample = Math.min(fallback * LEARN_CLAMP, Math.max(fallback / LEARN_CLAMP, usd / (mark.used - prev.used)));
        const all = this.load();
        const mine = (all.k[account] ??= {});
        const before = mine[kind];
        mine[kind] = before
          ? { k: before.k + LEARN_ALPHA * (sample - before.k), samples: before.samples + 1 }
          : { k: sample, samples: 1 };
        this.persist();
      }
      seen[kind] = mark;
      pending[kind] = 0;
    }
    this.lastSeen.set(account, seen);
    this.pendingUsd.set(account, pending);
  }

  private snapshot(account: string, kind: WindowKind, mark: WindowMark): void {
    const logged = this.logged.get(account) ?? {};
    if (logged[kind] !== undefined && Math.abs(logged[kind]! - mark.used) < 1) return;
    logged[kind] = mark.used;
    this.logged.set(account, logged);
    log.info('claude-accounts', 'quota-snapshot', {
      id: account,
      window: kind,
      used: mark.used,
      resetsAt: mark.resetsAt ?? null,
      k: round2(this.usdPerPercent(account, kind)),
    });
  }

  // ─── Sessions and jobs ────────────────────────────────────────────────────

  sessionAccount(sessionId: string | undefined): string | undefined {
    return sessionId ? this.load().sessions[sessionId]?.account : undefined;
  }

  sessionSize(sessionId: string | undefined): TaskSize | undefined {
    return sessionId ? this.load().sessions[sessionId]?.size : undefined;
  }

  rememberSession(sessionId: string, account: string, size: TaskSize): void {
    this.load().sessions[sessionId] = { account, size, at: this.opts.now() };
    this.persist();
  }

  /** The size the last runs of a scheduled job had, by their median cost. */
  jobSize(key: string | undefined): TaskSize | undefined {
    const costs = key ? this.load().jobs[key] : undefined;
    if (!costs || costs.length === 0) return undefined;
    const sorted = [...costs].sort((a, b) => a - b);
    return costToSize(sorted[Math.floor(sorted.length / 2)]!);
  }

  recordJobCost(key: string, usd: number): void {
    const all = this.load();
    all.jobs[key] = [...(all.jobs[key] ?? []), round2(usd)].slice(-JOB_HISTORY);
    this.persist();
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  private load(): SchedulingState {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as Partial<SchedulingState>;
      this.state = { k: raw.k ?? {}, sessions: raw.sessions ?? {}, jobs: raw.jobs ?? {} };
    } catch {
      this.state = { k: {}, sessions: {}, jobs: {} };
    }
    return this.state;
  }

  private persist(): void {
    const state = this.load();
    const cutoff = this.opts.now() - SESSION_TTL_MS;
    for (const [id, s] of Object.entries(state.sessions)) if (s.at < cutoff) delete state.sessions[id];
    const body = `${JSON.stringify(state, null, 2)}\n`;
    this.writing = this.writing
      .then(() => writeFileAtomic(this.opts.stateFile, body, { mode: 0o600 }))
      .catch((err: unknown) => log.warn('claude-accounts', 'scheduling-state-write-failed', { err: String(err) }));
  }
}

function sameWindow(a: WindowMark, b: WindowMark): boolean {
  if (a.resetsAt === undefined || b.resetsAt === undefined) return a.resetsAt === b.resetsAt;
  return Math.abs(a.resetsAt - b.resetsAt) <= SAME_WINDOW_MS;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
