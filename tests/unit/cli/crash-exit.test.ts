import { describe, expect, it } from 'vitest';
import { CRASH_EXIT_CODE, crashExitHandler } from '../../../src/cli/crash-exit';

function harness(shutdown?: () => Promise<void>) {
  const recorded: unknown[] = [];
  const exits: number[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const handler = crashExitHandler({
    record: (err) => recorded.push(err),
    shutdown: () => shutdown,
    exit: (code) => exits.push(code),
    deadlineMs: 50,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { handler, recorded, exits, timers };
}

describe('crash exit after an uncaught exception', () => {
  it('records, shuts down in order, then exits 1', async () => {
    let closed = false;
    const h = harness(async () => {
      closed = true;
    });
    h.handler(new Error('boom'));
    await new Promise((r) => setImmediate(r));
    expect(h.recorded).toHaveLength(1);
    expect(closed).toBe(true);
    expect(h.exits).toEqual([CRASH_EXIT_CODE]);
    expect(h.timers[0]?.ms).toBe(50);
  });

  it('exits at once when the process is not up yet', () => {
    const h = harness(undefined);
    h.handler(new Error('early'));
    expect(h.exits).toEqual([CRASH_EXIT_CODE]);
  });

  it('exits 1 even when the shutdown fails', async () => {
    const h = harness(async () => {
      throw new Error('teardown broke');
    });
    h.handler(new Error('boom'));
    await new Promise((r) => setImmediate(r));
    expect(h.exits).toEqual([CRASH_EXIT_CODE]);
  });

  it('a hanging shutdown is cut off by the deadline', () => {
    const h = harness(() => new Promise<void>(() => {}));
    h.handler(new Error('boom'));
    expect(h.exits).toEqual([]);
    h.timers[0]!.fn();
    expect(h.exits).toEqual([CRASH_EXIT_CODE]);
  });

  it('a second exception during shutdown exits immediately', () => {
    const h = harness(() => new Promise<void>(() => {}));
    h.handler(new Error('first'));
    h.handler(new Error('second'));
    expect(h.recorded).toHaveLength(2);
    expect(h.exits).toEqual([CRASH_EXIT_CODE]);
  });

  it('a throwing recorder does not stop the exit', () => {
    const exits: number[] = [];
    crashExitHandler({
      record: () => {
        throw new Error('log down');
      },
      shutdown: () => undefined,
      exit: (code) => exits.push(code),
    })(new Error('boom'));
    expect(exits).toEqual([CRASH_EXIT_CODE]);
  });
});
