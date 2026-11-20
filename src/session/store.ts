import { paths } from '../config/paths';
import { log } from '../core/logger';
import { JsonFile, type LoadProblem } from '../platform/json-file';

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. Session resets preserve this
   * scope preference while removing the resumable session id/cwd. */
  idleTimeoutMinutes?: number;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private readonly file: JsonFile;
  private loadProblem: LoadProblem | undefined;

  constructor(path: string = paths.sessionsFile) {
    this.file = new JsonFile(path, {
      mode: 0o600,
      // Unparseable JSON has been moved aside: start empty and let the owner
      // know. Anything else (unreadable, or the move failed) still refuses to
      // start, since writing now would replace the only copy.
      onLoadError: (err, movedTo) => {
        if (!movedTo) throw err;
        log.fail('session', err, { step: 'load', movedTo });
        this.loadProblem = { path, movedTo, error: String(err) };
      },
      onPersistError: (err) => log.fail('session', err, { step: 'persist' }),
    });
  }

  /** The unparseable file found at load, if any; cleared once read. */
  takeLoadProblem(): LoadProblem | undefined {
    const problem = this.loadProblem;
    this.loadProblem = undefined;
    return problem;
  }

  async load(): Promise<void> {
    const loaded = await this.file.load();
    if (loaded === undefined) return;
    const raw = loaded as Record<string, Partial<SessionEntry>>;
    this.data = {};
    for (const [chatId, entry] of Object.entries(raw)) {
      if (!entry || typeof entry.updatedAt !== 'number') continue;
      // Drop entries without a `cwd`/`sessionId` pair *unless* there's
      // some other persisted state worth keeping (e.g. an idle-timeout
      // override). Resuming a session whose cwd we don't know about
      // would hang claude on a missing jsonl, so resume keys still need
      // the full pair; but a bare timeout override is fine on its own.
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
      const idleTimeoutMinutes =
        typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
      const hasSession = sessionId !== undefined && cwd !== undefined;
      if (!hasSession && idleTimeoutMinutes === undefined) continue;
      this.data[chatId] = {
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        updatedAt: entry.updatedAt,
        ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
      };
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev) return;
    if (prev.idleTimeoutMinutes !== undefined) {
      this.data[chatId] = {
        idleTimeoutMinutes: prev.idleTimeoutMinutes,
        updatedAt: Date.now(),
      };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private schedulePersist(): void {
    this.file.write(`${JSON.stringify(this.data, null, 2)}
`);
  }
}
