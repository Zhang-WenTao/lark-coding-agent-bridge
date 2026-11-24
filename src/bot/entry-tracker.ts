import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EntryTracking } from '../config/profile-schema';
import { log } from '../core/logger';
import { paths } from '../config/paths';
import { defaultLarkCliExec, larkCliEnv, type LarkCliExec } from '../lark-cli/user-im';
import { type RunContext, runContextPath, writeRunContext } from './run-context';

/**
 * Tells which private chats came in through an outside entry (Alice's
 * "Antelope 研发助手" link). The link opens a Miaoda page that logs the
 * visitor (their open_id under this bot) before jumping to the bot chat, so a
 * private-chat turn whose sender visited that page shortly before is counted
 * as coming from the entry. The lookup runs after the turn has started — it
 * never delays a reply — and fills `entry` into the run-context file and an
 * append-only log that usage statistics read.
 */
export interface EntryVisit {
  /** Entry label, e.g. "alice" (the page's `?from=`). */
  source: string;
  /** ISO time of the visit. */
  visitedAt: string;
}

export interface EntryTurn {
  at: string;
  scope: string;
  chatId: string;
  openId: string;
  name?: string;
  ownerRun: boolean;
  source: string;
  visitedAt: string;
  messageIds: string[];
}

const OPEN_ID = /^ou_[0-9a-zA-Z]+$/;
const DEFAULT_WINDOW_MINUTES = 120;
const NEGATIVE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 8_000;

export function visitQuerySql(table: string, openId: string, windowMinutes: number): string {
  if (!OPEN_ID.test(openId)) throw new Error(`bad open_id: ${openId}`);
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table: ${table}`);
  const minutes = Math.max(1, Math.floor(windowMinutes));
  return (
    `SELECT source, _created_at FROM ${table} WHERE occam_open_id = '${openId}' ` +
    `AND _created_at > now() - interval '${minutes} minutes' ORDER BY _created_at DESC LIMIT 1`
  );
}

/** The newest visit in a `lark-cli apps +db-execute` reply, or undefined. */
export function parseVisit(stdout: string): EntryVisit | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) return undefined;
  const rows = (parsed as { data?: unknown }).data;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row._created_at !== 'string') return undefined;
  const at = Date.parse(row._created_at);
  if (!Number.isFinite(at)) return undefined;
  return {
    source: typeof row.source === 'string' && row.source ? row.source : 'alice',
    visitedAt: new Date(at).toISOString(),
  };
}

export interface EntryTrackerDeps {
  exec: LarkCliExec;
  env: () => NodeJS.ProcessEnv;
  appDir: string;
  now?: () => number;
}

export class EntryTracker {
  private readonly cache = new Map<string, { visit?: EntryVisit; until: number }>();
  private readonly inflight = new Map<string, Promise<EntryVisit | undefined>>();
  private readonly now: () => number;

  constructor(
    private readonly config: EntryTracking,
    private readonly deps: EntryTrackerDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  private get windowMs(): number {
    return (this.config.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000;
  }

  /** The sender's latest entry visit inside the window; cached so busy chats don't query every turn. */
  async lookup(openId: string): Promise<EntryVisit | undefined> {
    if (!OPEN_ID.test(openId)) return undefined;
    const hit = this.cache.get(openId);
    if (hit && hit.until > this.now()) return hit.visit;
    const running = this.inflight.get(openId);
    if (running) return running;
    const p = this.query(openId).finally(() => this.inflight.delete(openId));
    this.inflight.set(openId, p);
    return p;
  }

  private async query(openId: string): Promise<EntryVisit | undefined> {
    const sql = visitQuerySql(this.config.table ?? 'alice_visit', openId, this.config.windowMinutes ?? DEFAULT_WINDOW_MINUTES);
    const args = ['apps', '+db-execute', '--app-id', this.config.miaodaAppId, '--as', 'user', '--yes', '--sql', sql];
    const r = await this.deps.exec(args, this.deps.env(), LOOKUP_TIMEOUT_MS);
    const visit = r.code === 0 ? parseVisit(r.stdout) : undefined;
    if (r.code !== 0 || r.timedOut) {
      // Failure is not "no visit": retry on the next turn instead of caching a miss.
      log.warn('entry-tracker', 'lookup-failed', { code: r.code, timedOut: r.timedOut, err: (r.stderr || r.stdout).slice(0, 300) });
      return undefined;
    }
    const until = visit ? Date.parse(visit.visitedAt) + this.windowMs : this.now() + NEGATIVE_TTL_MS;
    this.cache.set(openId, { ...(visit ? { visit } : {}), until });
    return visit;
  }

  /**
   * Fire-and-forget after a private-chat batch started: when the sender came
   * through the entry, add `entry` to the run-context file (only if it still
   * describes this batch) and log the turn.
   */
  tagTurn(ctx: RunContext): void {
    if (ctx.mode !== 'p2p') return;
    const sender = ctx.senders.find((s) => s.type !== 'bot') ?? ctx.senders[0];
    if (!sender) return;
    void this.lookup(sender.openId)
      .then((visit) => {
        if (!visit) return;
        this.patchRunContext(ctx, visit);
        appendEntryTurn(this.deps.appDir, {
          at: ctx.updatedAt,
          scope: ctx.scope,
          chatId: ctx.chatId,
          openId: sender.openId,
          ...(sender.name ? { name: sender.name } : {}),
          ownerRun: ctx.ownerRun,
          source: visit.source,
          visitedAt: visit.visitedAt,
          messageIds: ctx.messageIds,
        });
      })
      .catch((err) => log.warn('entry-tracker', 'tag-failed', { err: String(err) }));
  }

  private patchRunContext(ctx: RunContext, visit: EntryVisit): void {
    const path = runContextPath(this.deps.appDir, ctx.scope);
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as RunContext;
      if (current.messageIds.join(',') !== ctx.messageIds.join(',')) return; // a newer batch already took over
    } catch {
      return;
    }
    writeRunContext(this.deps.appDir, { ...ctx, entry: visit });
  }
}

export function entryTurnsPath(appDir: string): string {
  return join(appDir, 'entry-turns.jsonl');
}

function appendEntryTurn(appDir: string, turn: EntryTurn): void {
  const path = entryTurnsPath(appDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(turn)}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn('entry-tracker', 'append-failed', { err: String(err) });
  }
}

let shared: { key: string; tracker: EntryTracker } | undefined;

/** The profile's tracker for the current config (rebuilt when the config changes), or undefined when off. */
export function entryTrackerFor(config: EntryTracking | undefined): EntryTracker | undefined {
  if (!config) return undefined;
  const key = JSON.stringify(config);
  if (shared?.key !== key) {
    const ctx = { profile: paths.profile, rootDir: paths.rootDir };
    shared = {
      key,
      tracker: new EntryTracker(config, { exec: defaultLarkCliExec, env: () => larkCliEnv(ctx), appDir: paths.appDir }),
    };
  }
  return shared.tracker;
}
