import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithAccountFailover } from '../../../src/agent/claude/account-failover.js';
import { claudeAccountsPaths, ClaudeAccountPool, parseSchedulingConfig } from '../../../src/agent/claude/accounts.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 25, 2, 0);

const dirs: string[] = [];
const pools: ClaudeAccountPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function limit(over: Partial<Extract<AgentEvent, { type: 'rate_limit' }>> = {}): Extract<AgentEvent, { type: 'rate_limit' }> {
  return { type: 'rate_limit', blocked: false, at: NOW, ...over };
}
const fiveHour = (usedPercent: number) => limit({ windows: [{ kind: 'five_hour', usedPercent, resetsAt: NOW + HOUR }] });

/**
 * Accounts `a` (the main one), `b`, `c` at the given 5-hour usage; the CLI's
 * own login is paused out of the way. Weeks are unreported (half full).
 */
async function schedPool(usage: Record<string, number>, scheduling: Record<string, unknown> = { mode: 'on' }) {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-sched-'));
  dirs.push(dir);
  const paths = claudeAccountsPaths(dir);
  const ids = Object.keys(usage);
  await writeFile(
    paths.configFile,
    JSON.stringify({
      accounts: [...ids.map((id) => ({ id, label: `${id}-name` })), { id: 'default', pausedUntil: NOW + 100 * HOUR }],
      scheduling,
    }),
  );
  const pool = new ClaudeAccountPool({
    paths,
    now: () => NOW,
    readSecret: async (secretId) => `tok-${secretId.replace('claude-oauth-', '')}`,
  });
  await pool.refresh();
  for (const [id, used] of Object.entries(usage)) pool.observe(id, fiveHour(used));
  pools.push(pool);
  return { pool, paths };
}

describe('scheduling config', () => {
  it('keeps what is valid', () => {
    expect(parseSchedulingConfig({ mode: 'on', maxBigLoad: 3, reserveUsd: { L: 10, X: 1 }, usdPerPercent: { five_hour: 1 } })).toEqual({
      mode: 'on',
      maxBigLoad: 3,
      reserveUsd: { L: 10 },
      usdPerPercent: { five_hour: 1 },
    });
    expect(parseSchedulingConfig({ mode: 'loud', maxBigLoad: 0, bigCommands: { '/Job': 'XL', bad: 'L', '/x': 'XXL' } })).toEqual({
      bigCommands: { '/job': 'XL' },
    });
    expect(parseSchedulingConfig('on')).toBeUndefined();
  });

  it('defaults to shadow', async () => {
    const { pool } = await schedPool({ a: 10 }, {});
    expect(pool.scheduler.mode).toBe('shadow');
  });
});

describe('AccountScheduler', () => {
  it('gives a big run the most room below the lines, and a small one the switch score among those it fits', async () => {
    // b is the furthest from its line; a (main) is close enough on score to stay main.
    const { pool } = await schedPool({ a: 50, b: 40, c: 42 });
    const s = pool.scheduler;
    expect(s.choose('L', 8.5)).toMatchObject({ account: 'b', why: 'most-room' });
    expect(pool.pickFor('L').account?.id).toBe('b');
    expect(pool.pickFor('L').borrow).toBe(true);
    expect(pool.pickFor('S')).toMatchObject({ account: { id: 'a' }, borrow: false });
    // Rooms are in dollars: 5-hour points left × what 1% holds ($0.70).
    expect(s.roomUsd('b', NOW)).toBeCloseTo(58 * 0.7);
  });

  it('spreads big runs: each reservation counts against its account', async () => {
    const { pool } = await schedPool({ a: 50, b: 40, c: 42 });
    const s = pool.scheduler;
    s.reserve('r1', 'b', 'L', 8.5);
    expect(s.roomUsd('b', NOW)).toBeCloseTo(58 * 0.7 - 8.5);
    expect(s.choose('L', 8.5, { runId: 'r2' })?.account).toBe('c');
    s.reserve('r2', 'c', 'L', 8.5);
    // A run's own reservation does not count against it.
    expect(s.choose('L', 8.5, { runId: 'r1' })?.account).toBe('b');
    s.release('r1');
    expect(s.roomUsd('b', NOW)).toBeCloseTo(58 * 0.7);
  });

  it('holds an account to its big-run load, unless every account is full', async () => {
    const { pool } = await schedPool({ a: 10, b: 60 }, { mode: 'on', maxBigLoad: 2 });
    const s = pool.scheduler;
    s.reserve('x1', 'a', 'L', 1);
    s.reserve('x2', 'a', 'L', 1);
    expect(s.bigLoad('a')).toBe(2);
    expect(s.choose('L', 8.5)).toMatchObject({ account: 'b', why: 'most-room' });
    s.reserve('x3', 'b', 'XL', 1);
    expect(s.choose('L', 8.5)).toMatchObject({ account: 'a', why: 'load-full' });
  });

  it('lets a reservation run down as the account’s usage rises, shared by the runs there', async () => {
    const { pool } = await schedPool({ a: 50, b: 40 });
    const s = pool.scheduler;
    s.reserve('r1', 'b', 'L', 7);
    s.reserve('r2', 'b', 'L', 7);
    // $7 at $0.70 a point is 10 points each; 10 points used since, 5 each.
    pool.observe('b', fiveHour(50));
    expect(s.remainingUsd('r1')).toBeCloseTo(5 * 0.7);
    expect(s.roomPct('b', NOW).five_hour).toBeCloseTo(98 - 50 - 10);
  });

  it('sees an account about to reach its line: the runs’ next steps and what pinned runs still hold', async () => {
    const { pool } = await schedPool({ a: 80, b: 10 });
    const s = pool.scheduler;
    s.reserve('r1', 'a', 'M', 3);
    pool.observe('a', fiveHour(86), 'r1');
    pool.observe('a', fiveHour(90), 'r1');
    // A step of 4: 90 + 4 is short of 98.
    expect(s.nearLine('a', 'r1')).toBe(false);
    pool.observe('a', fiveHour(95), 'r1');
    // Steps of 4 then 5: about 4.3 points a report; 95 + 4.3 is past 98.
    expect(s.nearLine('a', 'r1')).toBe(true);

    const other = await schedPool({ a: 60, b: 10 });
    other.pool.scheduler.reserve('big', 'a', 'XL', 43);
    other.pool.scheduler.reserve('small', 'a', 'S', 1);
    expect(other.pool.scheduler.nearLine('a', 'small')).toBe(false);
    // The XL run's subagents are out: it cannot leave, so its $43 (61 points) is as good as used.
    other.pool.scheduler.update('big', { unmovable: true });
    expect(other.pool.scheduler.nearLine('a', 'small')).toBe(true);
    expect(other.pool.scheduler.misfit('big')).toBe(true);
  });

  it('learns what 1% holds on an account from its runs’ costs', async () => {
    const { pool } = await schedPool({ a: 10, b: 10 });
    const s = pool.scheduler;
    expect(s.usdPerPercent('a', 'five_hour')).toBe(0.7);
    let used = 10;
    for (let i = 0; i < 5; i++) {
      s.noteCost('a', 4);
      used += 2;
      pool.observe('a', fiveHour(used));
    }
    // $4 per 2 points is $2 a point.
    expect(s.usdPerPercent('a', 'five_hour')).toBeCloseTo(2);
    expect(s.usdPerPercent('b', 'five_hour')).toBe(0.7);
  });

  it('remembers conversations’ accounts and jobs’ costs across restarts', async () => {
    const { pool, paths } = await schedPool({ a: 50, b: 40 });
    const s = pool.scheduler;
    s.rememberSession('sess', 'a', 'L');
    s.recordJobCost('job:x', 1);
    s.recordJobCost('job:x', 5);
    s.recordJobCost('job:x', 6);
    expect(s.jobSize('job:x')).toBe('L');
    expect(s.choose('L', 8.5, { sessionAccount: 'a' })).toMatchObject({ account: 'a', why: 'session' });
    expect(pool.pickFor('L', { sessionId: 'sess' }).account?.id).toBe('a');
    await pool.flush();
    const saved = JSON.parse(await readFile(paths.schedulingFile!, 'utf8'));
    expect(saved.sessions.sess).toMatchObject({ account: 'a', size: 'L' });
    expect(saved.jobs['job:x']).toEqual([1, 5, 6]);
  });

  it('in shadow mode picks as before', async () => {
    const { pool } = await schedPool({ a: 50, b: 40, c: 42 }, { mode: 'shadow' });
    expect(pool.pickFor('XL')).toEqual({ account: expect.objectContaining({ id: 'a' }), borrow: false });
  });
});

/** A promise to open by hand. */
function opened(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A scripted attempt; with a gate, it waits there before its turn ends. */
function scripted(events: AgentEvent[], gate?: Promise<void>): AgentRun {
  return {
    runId: 'r',
    pid: 1,
    events: (async function* () {
      yield* events;
      if (gate) await gate;
      yield { type: 'done', sessionId: 's1', terminationReason: 'normal' } as AgentEvent;
    })(),
    stop: async () => {},
    waitForExit: async () => true,
  };
}

async function drain(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const evt of run.events) out.push(evt);
  return out;
}

/** Reads the run until it has moved to another account. */
async function untilMoved(it: AsyncIterator<AgentEvent>): Promise<void> {
  for (;;) {
    const next = await it.next();
    if (next.done) throw new Error('the run never moved');
    if (next.value.type === 'account' && next.value.switchedFrom) return;
  }
}

const opts = (runId: string, over: Partial<AgentRunOptions> = {}): AgentRunOptions => ({
  runId,
  prompt: 'go',
  cwd: '/tmp',
  ...over,
});

describe('account failover with scheduling', () => {
  it('starts a big run on the account with the most room without making it the main one', async () => {
    const { pool } = await schedPool({ a: 50, b: 40, c: 42 });
    const spawned: string[] = [];
    const run = runWithAccountFailover(opts('big', { sizeHint: { size: 'XL', why: ['rating:subagents=6'] } }), {
      pool,
      spawn: (_o, account) => {
        spawned.push(account.id);
        return scripted([{ type: 'usage', costUsd: 2 }]);
      },
      labelOf: async (account) => account.label,
    });
    expect(pool.scheduler.reservationOf('big')).toMatchObject({ account: 'b', size: 'XL', reserveUsd: 43 });
    await drain(run);
    expect(spawned).toEqual(['b']);
    expect(pool.accounts()[0]?.id).toBe('a');
    expect(pool.scheduler.reservationOf('big')).toBeUndefined();
  });

  it('11-25 replay: two big runs leaving one account at once land on different accounts', async () => {
    const { pool } = await schedPool({ a: 50, b: 40, c: 42 });
    const gate = opened();
    const moved: Record<string, string> = {};
    const makeRun = (runId: string) =>
      runWithAccountFailover(opts(runId), {
        pool,
        spawn: (_o, account) => {
          if (account.id === 'a') {
            // Small at first; a subagent makes it big; the report puts `a` past its line.
            return scripted([
              { type: 'tool_use', id: `${runId}-t1`, name: 'Agent', input: {} },
              fiveHour(99),
              { type: 'tool_result', id: `${runId}-t1`, output: 'ok', isError: false },
              { type: 'text', delta: 'never shown' },
            ]);
          }
          moved[runId] = account.id;
          return scripted([{ type: 'text', delta: 'resumed' }], gate.promise);
        },
        labelOf: async (account) => account.label,
      });
    const r1 = makeRun('r1');
    const r2 = makeRun('r2');
    const i1 = r1.events[Symbol.asyncIterator]();
    const i2 = r2.events[Symbol.asyncIterator]();
    await untilMoved(i1);
    await untilMoved(i2);
    expect(moved).toEqual({ r1: 'b', r2: 'c' });
    // Neither took its account over as the main one.
    expect(pool.accounts()[0]?.id).toBe('a');
    gate.resolve();
    for (const i of [i1, i2]) while (!(await i.next()).done);
  });

  it('in shadow mode the same runs both go where the pool’s rounds send them', async () => {
    const { pool } = await schedPool({ a: 50, b: 40, c: 42 }, { mode: 'shadow' });
    const gate = opened();
    const moved: Record<string, string> = {};
    const makeRun = (runId: string) =>
      runWithAccountFailover(opts(runId), {
        pool,
        spawn: (_o, account) => {
          if (account.id === 'a') {
            return scripted([
              { type: 'tool_use', id: `${runId}-t1`, name: 'Agent', input: {} },
              fiveHour(99),
              { type: 'tool_result', id: `${runId}-t1`, output: 'ok', isError: false },
            ]);
          }
          moved[runId] = account.id;
          return scripted([], gate.promise);
        },
        labelOf: async (account) => account.label,
      });
    const i1 = makeRun('r1').events[Symbol.asyncIterator]();
    const i2 = makeRun('r2').events[Symbol.asyncIterator]();
    await untilMoved(i1);
    await untilMoved(i2);
    expect(moved).toEqual({ r1: 'b', r2: 'b' });
    gate.resolve();
    for (const i of [i1, i2]) while (!(await i.next()).done);
  });

  it('leaves early, at a quiet point, when its steps are about to bring the account to its line', async () => {
    const { pool } = await schedPool({ a: 80, b: 75 });
    const spawned: string[] = [];
    const run = runWithAccountFailover(opts('r'), {
      pool,
      spawn: (_o, account) => {
        spawned.push(account.id);
        if (account.id !== 'a') return scripted([{ type: 'text', delta: 'on b' }]);
        return scripted([
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          fiveHour(86),
          { type: 'tool_result', id: 't1', output: '', isError: false },
          { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
          fiveHour(90),
          { type: 'tool_result', id: 't2', output: '', isError: false },
          { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
          fiveHour(95),
          { type: 'tool_result', id: 't3', output: '', isError: false },
          { type: 'text', delta: 'still on a' },
        ]);
      },
      labelOf: async (account) => account.label,
    });
    const events = await drain(run);
    expect(spawned).toEqual(['a', 'b']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'account', switchedFrom: 'a-name', reason: expect.stringContaining('快到切换线') }));
    expect(events).not.toContainEqual({ type: 'text', delta: 'still on a' });
  });

  it('in shadow mode only logs the early move', async () => {
    const { pool } = await schedPool({ a: 80, b: 75 }, { mode: 'shadow' });
    const spawned: string[] = [];
    const run = runWithAccountFailover(opts('r'), {
      pool,
      spawn: (_o, account) => {
        spawned.push(account.id);
        return scripted([
          fiveHour(86),
          fiveHour(90),
          fiveHour(95),
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_result', id: 't1', output: '', isError: false },
        ]);
      },
      labelOf: async (account) => account.label,
    });
    await drain(run);
    expect(spawned).toEqual(['a']);
  });

  it('remembers the run’s account and size for its conversation, and its cost for its job', async () => {
    const { pool } = await schedPool({ a: 50, b: 40 });
    const run = runWithAccountFailover(opts('job-run', { sessionId: 's0', sizeKey: 'job:abc' }), {
      pool,
      spawn: () =>
        scripted([
          { type: 'system', sessionId: 's1' },
          { type: 'usage', costUsd: 3 },
          { type: 'usage', costUsd: 2 },
        ]),
      labelOf: async (account) => account.label,
    });
    await drain(run);
    const s = pool.scheduler;
    // $3 takes it from S past M (80% of $1, then of $3) to L.
    expect(s.sessionSize('s1')).toBe('L');
    expect(s.sessionAccount('s1')).toBe('a');
    expect(s.jobSize('job:abc')).toBe('L');
    // The job's next run starts on that size.
    const next = runWithAccountFailover(opts('job-run-2', { sizeKey: 'job:abc' }), {
      pool,
      spawn: () => scripted([]),
      labelOf: async (account) => account.label,
    });
    expect(s.reservationOf('job-run-2')).toMatchObject({ size: 'L' });
    await drain(next);
  });
});
