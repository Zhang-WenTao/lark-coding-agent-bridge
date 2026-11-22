import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installChildLedger, trackAgentChild, uninstallChildLedger } from '../../src/platform/child-ledger';
import { reapOrphanAgentChildren, sameProcess, type ReapDeps } from '../../src/runtime/reap-agent-children';

const DEAD_PID = 999_999;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lstart = (pid: number): string =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
const waitGone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const dirs: string[] = [];
const kids: number[] = [];
afterEach(() => {
  uninstallChildLedger();
  for (const pid of kids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lcb-children-'));
  dirs.push(d);
  return d;
}

function sleeper(): number {
  const child = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  child.unref();
  kids.push(child.pid!);
  return child.pid!;
}

describe.skipIf(process.platform === 'win32')('agent child ledger (process)', () => {
  it('records a spawned agent until it exits', async () => {
    const dir = tmp();
    installChildLedger(dir, 4242);
    const child = spawn('sleep', ['1'], { stdio: 'ignore' });
    kids.push(child.pid!);
    trackAgentChild(child, '/usr/bin/sleep');
    const file = join(dir, '4242.json');
    const read = () => JSON.parse(readFileSync(file, 'utf8')) as { children: Array<{ pid: number; command: string; startTime?: string }> };
    expect(read().children).toEqual([expect.objectContaining({ pid: child.pid, command: 'sleep' })]);
    for (let i = 0; i < 40 && !read().children[0]?.startTime; i++) await new Promise((r) => setTimeout(r, 25));
    expect(read().children[0]?.startTime).toBe(lstart(child.pid!));
    await new Promise((r) => child.once('exit', r));
    expect(read().children).toEqual([]);
  });

  it('stops what a dead bridge left running and drops its ledger', async () => {
    const dir = tmp();
    const pid = sleeper();
    const file = join(dir, `${DEAD_PID}.json`);
    writeFileSync(file, JSON.stringify({ children: [{ pid, command: 'sleep', spawnedAt: Date.now(), startTime: lstart(pid) }] }));
    const reaped = await reapOrphanAgentChildren(dir, undefined, 200);
    expect(reaped).toEqual([{ ownerPid: DEAD_PID, pid, command: 'sleep', killed: true }]);
    expect(await waitGone(pid)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('leaves a process alone when the pid was reused (start time differs)', async () => {
    const dir = tmp();
    const pid = sleeper();
    writeFileSync(
      join(dir, `${DEAD_PID}.json`),
      JSON.stringify({ children: [{ pid, command: 'sleep', spawnedAt: 0, startTime: 'Mon Jan 1 00:00:00 2001' }] }),
    );
    const reaped = await reapOrphanAgentChildren(dir, undefined, 50);
    expect(reaped[0]?.killed).toBe(false);
    expect(alive(pid)).toBe(true);
  });

  it('records and reaps under a non-English locale (ps lstart is read in the C locale)', async () => {
    const saved = process.env.LC_ALL;
    process.env.LC_ALL = 'zh_CN.UTF-8';
    try {
      const dir = tmp();
      installChildLedger(dir, 4243);
      const child = spawn('sleep', ['1'], { stdio: 'ignore' });
      kids.push(child.pid!);
      trackAgentChild(child, '/bin/sleep');
      const file = join(dir, '4243.json');
      const read = () => JSON.parse(readFileSync(file, 'utf8')) as { children: Array<{ startTime?: string }> };
      for (let i = 0; i < 40 && !read().children[0]?.startTime; i++) await new Promise((r) => setTimeout(r, 25));
      expect(read().children[0]?.startTime).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d{4}$/);
      uninstallChildLedger();

      const pid = sleeper();
      const ledger = join(dir, `${DEAD_PID}.json`);
      writeFileSync(ledger, JSON.stringify({ children: [{ pid, command: 'sleep', spawnedAt: 0, startTime: lstart(pid) }] }));
      const reaped = await reapOrphanAgentChildren(dir, undefined, 200);
      expect(reaped).toContainEqual({ ownerPid: DEAD_PID, pid, command: 'sleep', killed: true });
      expect(await waitGone(pid)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = saved;
    }
  });

  it('leaves the ledger of a bridge that is still running', async () => {
    const dir = tmp();
    const pid = sleeper();
    const file = join(dir, `${process.ppid}.json`);
    writeFileSync(file, JSON.stringify({ children: [{ pid, command: 'sleep', spawnedAt: 0, startTime: lstart(pid) }] }));
    expect(await reapOrphanAgentChildren(dir, undefined, 50)).toEqual([]);
    expect(alive(pid)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});

describe('sameProcess', () => {
  const info = { ppid: 1, startTime: 'Fri Nov 20 19:55:47 2026', command: 'claude -p --verbose' };
  it('matches on start time and executable', () => {
    expect(sameProcess({ pid: 1, command: 'claude', spawnedAt: 0, startTime: 'Fri Nov 20  19:55:47 2026' }, info)).toBe(true);
    expect(sameProcess({ pid: 1, command: 'codex', spawnedAt: 0, startTime: info.startTime }, info)).toBe(false);
  });
  it('without a start time only takes an orphan of the same executable', () => {
    expect(sameProcess({ pid: 1, command: 'claude', spawnedAt: 0 }, info)).toBe(true);
    expect(sameProcess({ pid: 1, command: 'claude', spawnedAt: 0 }, { ...info, ppid: 500 })).toBe(false);
    expect(sameProcess({ pid: 1, command: 'claude', spawnedAt: 0 }, { ...info, command: '/opt/x/claude --resume a' })).toBe(true);
  });
});

describe('reap with fake deps', () => {
  it('escalates to SIGKILL for what survives SIGTERM, including descendants', async () => {
    const dir = tmp();
    writeFileSync(join(dir, `${DEAD_PID}.json`), JSON.stringify({ children: [{ pid: 10, command: 'claude', spawnedAt: 0, startTime: 'T' }] }));
    const signals: Array<[number[], string]> = [];
    const deps: ReapDeps = {
      isAlive: (p) => p !== DEAD_PID,
      inspect: () => ({ ppid: 1, startTime: 'T', command: 'claude -p' }),
      descendants: () => [11, 12],
      signal: (pids, sig) => signals.push([[...pids], sig]),
      sleep: async () => {},
    };
    await reapOrphanAgentChildren(dir, deps);
    expect(signals).toEqual([
      [[10, 11, 12], 'SIGTERM'],
      [[10, 11, 12], 'SIGKILL'],
    ]);
  });
});
