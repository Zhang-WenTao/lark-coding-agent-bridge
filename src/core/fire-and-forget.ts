import { log, type LogFields } from './logger';

/**
 * Start `work` without waiting for it. A failure is logged under `phase`
 * with `fields`, instead of reaching the process-wide unhandled-rejection
 * handler as one line with no idea which run or chat it came from.
 */
export function fireAndForget(work: Promise<unknown>, phase: string, fields?: LogFields): void {
  work.catch((err: unknown) => log.fail(phase, err, fields));
}
