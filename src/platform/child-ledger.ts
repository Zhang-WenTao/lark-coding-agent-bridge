import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { log } from '../core/logger';

/**
 * Agent processes (claude / codex) this bridge process started and that are
 * still running, on disk so that the *next* bridge process can find them if
 * this one dies without stopping them (SIGKILL, crash): they would otherwise
 * be reparented to launchd and keep spending quota with nobody reading them.
 *
 * One file per bridge process — `<dir>/<bridge pid>.json` — so concurrent
 * daemons never write the same file. Written synchronously: it is small and
 * has to be on disk before the process could be killed.
 */
export interface ChildRecord {
  pid: number;
  /** Basename of the executable, e.g. `claude`. */
  command: string;
  spawnedAt: number;
  /** `ps -o lstart=` of the child, once known: tells it apart from a reused pid. */
  startTime?: string;
}

export interface ChildLedgerFile {
  ownerPid: number;
  file: string;
  children: ChildRecord[];
}

interface Installed {
  dir: string;
  file: string;
  children: Map<number, ChildRecord>;
}

let installed: Installed | undefined;

/**
 * Environment for `ps`: `lstart` follows the locale (`日 11月/22 23:00:19 2026`
 * under zh_CN), and the reaper only reads the C-locale form. Recording and
 * reading both use it, so a bridge started under another locale still reaps.
 */
export function psEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C' };
}

/** Start recording this process's agent children under `dir`. */
export function installChildLedger(dir: string, ownerPid: number = process.pid): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  installed = { dir, file: join(dir, `${ownerPid}.json`), children: new Map() };
  persist();
}

/** For tests: stop recording. */
export function uninstallChildLedger(): void {
  installed = undefined;
}

/**
 * Record a just-spawned agent process until it exits. A no-op when no ledger
 * is installed (tests, one-off CLI commands).
 */
export function trackAgentChild(child: ChildProcess, command: string): void {
  const ledger = installed;
  const pid = child.pid;
  if (!ledger || !pid) return;
  const rec: ChildRecord = { pid, command: basename(command), spawnedAt: Date.now() };
  ledger.children.set(pid, rec);
  persist();
  child.once('exit', () => {
    if (ledger.children.delete(pid)) persist();
  });
  if (process.platform === 'win32') return;
  execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: psEnv() }, (err, stdout) => {
    const startTime = String(stdout ?? '').trim();
    if (err || !startTime || ledger.children.get(pid) !== rec) return;
    rec.startTime = startTime;
    persist();
  });
}

function persist(): void {
  const ledger = installed;
  if (!ledger) return;
  const body = JSON.stringify({ children: [...ledger.children.values()] }, null, 2);
  const tmp = `${ledger.file}.tmp`;
  try {
    writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
    renameSync(tmp, ledger.file);
  } catch (err) {
    log.warn('child-ledger', 'persist-failed', { err: String(err) });
  }
}

/** Every ledger file under `dir` except the one of `exceptPid`. */
export function readChildLedgers(dir: string, exceptPid: number = process.pid): ChildLedgerFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ChildLedgerFile[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const ownerPid = Number(m[1]);
    if (ownerPid === exceptPid) continue;
    const file = join(dir, name);
    let children: ChildRecord[] = [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { children?: unknown };
      if (Array.isArray(raw.children)) {
        children = raw.children.filter(
          (c): c is ChildRecord =>
            !!c && typeof c === 'object' && Number.isInteger((c as ChildRecord).pid) &&
            typeof (c as ChildRecord).command === 'string',
        );
      }
    } catch (err) {
      log.warn('child-ledger', 'read-failed', { file, err: String(err) });
    }
    out.push({ ownerPid, file, children });
  }
  return out;
}

export function removeChildLedger(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}
