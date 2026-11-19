import { log } from '../core/logger';
import { CronParseError, nextCronTime, parseCron } from './cron';
import { notifyJobChat, runScheduledJob, scheduleLabel, type JobRunnerDeps } from './runner';
import type { JobStore } from './store';
import { jobTitleMd, type JobRunRecord, type ScheduledJob } from './types';

/** How often the scheduler looks for due jobs. */
const DEFAULT_TICK_MS = 30_000;

/**
 * How late a cron fire may be and still run after downtime.
 *
 * The bridge runs on someone's laptop, which sleeps. Firing a 09:00 daily job
 * at 10:30 when the lid opens is what the person wanted; firing last Tuesday's
 * at the same moment is noise. Six hours splits those two cases, and a missed
 * slot older than that is logged and skipped rather than replayed.
 */
const CRON_CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Consecutive failures after which a job is disarmed instead of retried forever. */
const MAX_FAILURE_STREAK = 5;

export interface SchedulerOptions extends JobRunnerDeps {
  store: JobStore;
  tickMs?: number;
  now?: () => number;
  /** Injectable for tests — defaults to the real agent run. */
  runJob?: (job: ScheduledJob) => Promise<JobRunRecord>;
  /**
   * How many scheduled fires may run at once (`cronMaxConcurrentJobs`).
   * Default 1: due jobs wait their turn, one after another. Manual
   * `/cron run` does not take a slot.
   */
  maxConcurrentJobs?: number;
}

/**
 * Fires scheduled jobs while the bridge is connected.
 *
 * Lives inside `startChannel`, so exactly one process per profile ever ticks:
 * the profile runtime lock already guarantees a single live bridge, and a job
 * that fired twice would double-post into a chat.
 */
export class Scheduler {
  private readonly opts: SchedulerOptions;
  private readonly store: JobStore;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  /** Due or running jobs: a job here is never dispatched again until it ends. */
  private readonly inFlight = new Set<string>();
  private readonly slots: Slots;
  /** Set by {@link stop}: runs that end after this were cut short by the shutdown. */
  private stopping = false;
  /** Bumped by {@link stop}, so a fire queued before it knows not to start. */
  private stops = 0;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.slots = new Slots(Math.max(1, Math.floor(opts.maxConcurrentJobs ?? 1)));
  }

  /** The job list this scheduler drives — what `/cron` reads and edits. */
  get jobs(): JobStore {
    return this.store;
  }

  /** Arm every enabled job and start ticking. */
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    let armed = 0;
    const now = this.now();
    for (const job of this.store.list()) {
      if (!job.enabled) continue;
      // A slot that is already due was never completed: the bridge was down,
      // the job was queued behind another one, or a restart cut it short.
      // Keep it so the next tick replays it (or, past the catch-up window,
      // logs it as missed); recomputing from now would silently drop it.
      const pending = job.nextRunAt !== undefined && job.nextRunAt <= now;
      const next = pending ? job.nextRunAt : this.computeNextRun(job);
      if (next !== job.nextRunAt) this.store.update(job.id, { nextRunAt: next });
      if (next !== undefined) armed++;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => log.fail('scheduler', err, { step: 'tick' }));
    }, this.opts.tickMs ?? DEFAULT_TICK_MS);
    // Keeping the event loop alive for the scheduler alone would stop the
    // process from exiting; the bridge's own WS connection is what holds it.
    this.timer.unref?.();
    log.info('scheduler', 'started', { jobs: this.store.list().length, armed });
  }

  stop(): void {
    if (!this.timer) return;
    this.stopping = true;
    this.stops++;
    clearInterval(this.timer);
    this.timer = undefined;
    log.info('scheduler', 'stopped', { inFlight: this.inFlight.size });
  }

  /**
   * Dispatch everything that is due, and resolve once those runs (and any
   * still queued for a slot) have ended. Exposed for tests and for the
   * "check right now" path.
   *
   * Dispatch itself never waits, so a tick that comes while a long job is
   * running still picks up newly due jobs: they queue for a slot (in list
   * order) instead of waiting for that whole tick to finish, and the
   * catch-up window is judged when a job falls due, not when its turn comes.
   * A job already due or running is skipped, never queued twice.
   */
  async tick(): Promise<void> {
    const now = this.now();
    const stops = this.stops;
    const dispatched: Promise<void>[] = [];
    for (const job of this.store.list()) {
      if (!job.enabled || job.nextRunAt === undefined) continue;
      if (job.nextRunAt > now) continue;
      if (this.inFlight.has(job.id)) continue;

      const lateBy = now - job.nextRunAt;
      if (job.schedule.kind === 'cron' && lateBy > CRON_CATCHUP_WINDOW_MS) {
        log.info('scheduler', 'job-missed', { jobId: job.id, lateByMs: lateBy });
        this.store.update(job.id, { nextRunAt: this.computeNextRun(job, now) });
        continue;
      }
      this.inFlight.add(job.id);
      dispatched.push(this.fireWhenFree(job.id, stops));
    }
    await Promise.all(dispatched);
  }

  /** Wait for a slot, then fire the job as it stands by then. */
  private async fireWhenFree(jobId: string, stopsAtDispatch: number): Promise<void> {
    const release = await this.slots.acquire();
    try {
      // Paused, deleted, re-armed to a later slot, or the bridge stopped
      // while it waited: leave the slot alone so a resume, the new slot or
      // the restarted bridge decides what runs.
      const job = this.store.get(jobId);
      const stopped = this.stops !== stopsAtDispatch;
      if (!job?.enabled || job.nextRunAt === undefined || job.nextRunAt > this.now() || stopped) {
        log.info('scheduler', 'job-dropped-from-queue', { jobId, stopped });
        return;
      }
      await this.fire(job);
    } finally {
      this.inFlight.delete(jobId);
      release();
    }
  }

  /** Run a job right now, independent of its schedule (`/cron run <id>`). */
  async runNow(jobId: string): Promise<JobRunRecord | undefined> {
    const job = this.store.get(jobId);
    if (!job) return undefined;
    if (this.inFlight.has(jobId)) {
      return { startedAt: this.now(), finishedAt: this.now(), ok: false, error: '该任务正在执行或排队中' };
    }
    return this.fire(job, { manual: true });
  }

  /**
   * Compute a job's next fire time. Returns `undefined` when the job can never
   * fire again (a one-shot whose time has passed, an unsatisfiable cron).
   */
  computeNextRun(job: ScheduledJob, from: number = this.now()): number | undefined {
    if (job.schedule.kind === 'once') {
      return job.schedule.at > from ? job.schedule.at : undefined;
    }
    try {
      return nextCronTime(parseCron(job.schedule.expr), new Date(from))?.getTime();
    } catch (err) {
      // A hand-edited jobs.json can hold an expression that no longer parses.
      // Leaving it unarmed is better than crashing the tick loop.
      if (err instanceof CronParseError) {
        log.warn('scheduler', 'job-bad-cron', { jobId: job.id, expr: job.schedule.expr });
        return undefined;
      }
      throw err;
    }
  }

  /** Arm (or re-arm) one job after it was created, edited, or resumed. */
  armJob(jobId: string): ScheduledJob | undefined {
    const job = this.store.get(jobId);
    if (!job) return undefined;
    const next = job.enabled ? this.computeNextRun(job) : undefined;
    return this.store.update(jobId, { nextRunAt: next });
  }

  private async fire(job: ScheduledJob, opts: { manual?: boolean } = {}): Promise<JobRunRecord> {
    this.inFlight.add(job.id);
    let record: JobRunRecord;
    try {
      record = this.opts.runJob
        ? await this.opts.runJob(job)
        : await runScheduledJob(this.opts, job);
    } catch (err) {
      // runScheduledJob is written not to throw; this is the backstop that
      // keeps one broken job from killing the tick loop.
      log.fail('scheduler', err, { jobId: job.id, step: 'fire' });
      record = {
        startedAt: this.now(),
        finishedAt: this.now(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.inFlight.delete(job.id);
    }

    // Cut short by our own shutdown (a restart): the slot was not really run.
    // Leave nextRunAt on it and do not count a failure — the restarted bridge
    // replays it within the catch-up window. Manual runs have no slot to keep.
    if (this.stopping && !opts.manual && !record.ok && record.terminal === 'interrupted') {
      log.info('scheduler', 'job-interrupted-by-shutdown', { jobId: job.id });
      this.store.update(job.id, { lastRun: record });
      return record;
    }

    // A one-shot has done its whole job; keeping a dead record around would
    // only clutter `/cron list`.
    if (job.schedule.kind === 'once' && !opts.manual) {
      this.store.remove(job.id);
      if (!record.ok) {
        await notifyJobChat(this.opts, job, failureNotice(job, record));
      }
      return record;
    }

    // A manual `/cron run` is how someone tests a job; letting those failures
    // count toward auto-disable would silently disarm a schedule that was only
    // ever being debugged. It records the outcome and leaves the arming alone.
    if (opts.manual) {
      this.store.update(job.id, { lastRun: record });
      if (!record.ok) await notifyJobChat(this.opts, job, failureNotice(job, record));
      return record;
    }

    const failureStreak = record.ok ? 0 : (job.failureStreak ?? 0) + 1;
    const exhausted = failureStreak >= MAX_FAILURE_STREAK;
    const current = this.store.get(job.id) ?? job;
    this.store.update(job.id, {
      lastRun: record,
      failureStreak,
      ...(exhausted
        ? { enabled: false, nextRunAt: undefined }
        : { nextRunAt: this.computeNextRun(current, this.now()) }),
    });

    if (!record.ok) {
      await notifyJobChat(
        this.opts,
        job,
        exhausted
          ? `${failureNotice(job, record)}\n\n已连续失败 ${failureStreak} 次，任务已自动暂停。修好后用 \`/cron resume ${job.id}\` 恢复。`
          : failureNotice(job, record),
      );
    }
    return record;
  }
}

function failureNotice(job: ScheduledJob, record: JobRunRecord): string {
  return `⏰ 定时任务 ${jobTitleMd(job)}（${scheduleLabel(job)}）执行失败：${record.error ?? '未知原因'}`;
}

/** A counting semaphore: at most `size` holders, waiters served in order. */
class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.free = size;
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter, so a newcomer cannot
      // overtake the queue between release and wake-up.
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}
