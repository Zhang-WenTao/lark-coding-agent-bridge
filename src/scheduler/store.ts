import { randomBytes } from 'node:crypto';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { JsonFile } from '../platform/json-file';
import { isScheduledJob, type ScheduledJob } from './types';

interface JobData {
  jobs: Record<string, ScheduledJob>;
}

/**
 * Durable per-profile list of scheduled jobs.
 *
 * Same shape and durability contract as the session / workspace stores:
 * atomic 0600 writes, serialized persists, and a load that tolerates a
 * truncated or hand-edited file rather than refusing to start the bridge.
 */
export class JobStore {
  private data: JobData = { jobs: {} };
  private readonly file: JsonFile;
  /** Set when a corrupt jobs file could not be moved aside (see constructor). */
  private readOnly = false;

  constructor(path: string = paths.jobsFile) {
    this.file = new JsonFile(path, {
      mode: 0o600,
      onLoadError: (err, movedTo, kind) => {
        if (kind === 'read') throw err;
        // A corrupt jobs file must not take the bridge down with it — chat still
        // works, the operator finds the reason in the log, and the original is
        // kept at `movedTo` instead of being overwritten by the next save.
        log.warn('scheduler', 'jobs-parse-failed', { path, movedTo, err: String(err) });
        // Could not move it aside: it is still the only copy, so this process
        // must not save over it. Jobs added now last until the next restart.
        if (!movedTo) {
          this.readOnly = true;
          log.fail('scheduler', err, { step: 'load', path, note: 'corrupt jobs file kept in place; saves disabled' });
        }
      },
      onPersistError: (err) => log.fail('scheduler', err, { step: 'persist' }),
    });
  }

  async load(): Promise<void> {
    const parsed = (await this.file.load()) as Partial<JobData> | undefined;
    if (!parsed || typeof parsed !== 'object') return;
    const jobs: Record<string, ScheduledJob> = {};
    let dropped = 0;
    for (const [id, entry] of Object.entries(parsed.jobs ?? {})) {
      if (!isScheduledJob(entry)) {
        dropped++;
        continue;
      }
      jobs[id] = entry;
    }
    this.data = { jobs };
    if (dropped > 0) log.warn('scheduler', 'jobs-dropped', { dropped });
  }

  list(): ScheduledJob[] {
    return Object.values(this.data.jobs).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Jobs owned by one chat — what `/cron list` shows in that chat. */
  listForChat(chatId: string, threadId?: string): ScheduledJob[] {
    return this.list().filter(
      (job) => job.chatId === chatId && (threadId === undefined || job.threadId === threadId),
    );
  }

  get(id: string): ScheduledJob | undefined {
    return this.data.jobs[id];
  }

  add(job: Omit<ScheduledJob, 'id'> & { id?: string }): ScheduledJob {
    const id = job.id ?? this.freshId();
    const created: ScheduledJob = { ...job, id };
    this.data.jobs[id] = created;
    this.schedulePersist();
    return created;
  }

  update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | undefined {
    const existing = this.data.jobs[id];
    if (!existing) return undefined;
    const next: ScheduledJob = { ...existing, ...patch, id };
    this.data.jobs[id] = next;
    this.schedulePersist();
    return next;
  }

  remove(id: string): boolean {
    if (!(id in this.data.jobs)) return false;
    delete this.data.jobs[id];
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  /**
   * Six hex chars is plenty for a per-profile list a human types back into
   * `/cron remove`, and short enough to read off a card.
   */
  private freshId(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = randomBytes(3).toString('hex');
      if (!(id in this.data.jobs)) return id;
    }
    return randomBytes(6).toString('hex');
  }

  private schedulePersist(): void {
    if (this.readOnly) return;
    this.file.write(`${JSON.stringify(this.data, null, 2)}\n`);
  }
}
