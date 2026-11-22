import { execFileSync } from 'node:child_process';
import { log } from '../core/logger';
import { listDescendants, signalAll } from '../agent/process-tree';
import { psEnv, readChildLedgers, removeChildLedger, type ChildRecord } from '../platform/child-ledger';
import { isAlive } from './registry';

/** What `ps` says about a pid right now; undefined if it is gone. */
export interface ProcInfo {
  ppid: number;
  startTime: string;
  command: string;
}

export interface ReapDeps {
  isAlive(pid: number): boolean;
  inspect(pid: number): ProcInfo | undefined;
  descendants(pid: number): number[];
  signal(pids: readonly number[], sig: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

export interface Reaped {
  ownerPid: number;
  pid: number;
  command: string;
  killed: boolean;
}

function inspect(pid: number): ProcInfo | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      env: psEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // "  1 Fri Nov 20 19:00:40 2026     /path/to/claude --flags"
    const m = /^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(out);
    if (!m) return undefined;
    return { ppid: Number(m[1]), startTime: m[2]!.replace(/\s+/g, ' '), command: m[3]! };
  } catch {
    return undefined;
  }
}

const defaultDeps: ReapDeps = {
  isAlive,
  inspect,
  descendants: listDescendants,
  signal: signalAll,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Is the live process `info` still the agent `rec` recorded? A pid can be
 * reused, so the start time must match; without a recorded start time, only
 * an orphan (reparented to init) running the same executable qualifies.
 */
export function sameProcess(rec: ChildRecord, info: ProcInfo): boolean {
  const runsIt = info.command.split(/\s+/).some((w) => w.split('/').pop() === rec.command || w.endsWith(`/${rec.command}`));
  if (rec.startTime) return info.startTime === rec.startTime.replace(/\s+/g, ' ') && runsIt;
  return info.ppid === 1 && runsIt;
}

/**
 * At startup: stop the agent processes a bridge process that is gone left
 * running (§6 L3), with whatever they started, then drop its ledger.
 * Ledgers of bridge processes that are still alive are left alone.
 */
export async function reapOrphanAgentChildren(
  dir: string,
  deps: ReapDeps = defaultDeps,
  graceMs = 3000,
): Promise<Reaped[]> {
  const reaped: Reaped[] = [];
  for (const ledger of readChildLedgers(dir)) {
    if (deps.isAlive(ledger.ownerPid)) continue;
    const doomed: number[] = [];
    for (const rec of ledger.children) {
      const info = deps.isAlive(rec.pid) ? deps.inspect(rec.pid) : undefined;
      const match = info !== undefined && sameProcess(rec, info);
      reaped.push({ ownerPid: ledger.ownerPid, pid: rec.pid, command: rec.command, killed: match });
      if (match) doomed.push(rec.pid, ...deps.descendants(rec.pid));
    }
    if (doomed.length > 0) {
      deps.signal(doomed, 'SIGTERM');
      await deps.sleep(graceMs);
      deps.signal(doomed.filter((p) => deps.isAlive(p)), 'SIGKILL');
    }
    removeChildLedger(ledger.file);
  }
  for (const r of reaped.filter((x) => x.killed)) {
    log.warn('agent-children', 'orphan-reaped', { ownerPid: r.ownerPid, pid: r.pid, command: r.command });
  }
  return reaped;
}
