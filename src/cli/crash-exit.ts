/**
 * What the process does after an uncaught exception: the stack it was in has
 * been unwound half way, so its state can no longer be trusted. Log it, shut
 * down the usual way (stop runs, release locks) within a deadline, and exit
 * non-zero so the service manager (launchd `KeepAlive`) starts a fresh one.
 *
 * A second exception while shutting down, or a shutdown that hangs past the
 * deadline, exits at once: a broken process must not linger.
 */
export interface CrashExitDeps {
  /** Record the error (log + error report). Must not throw. */
  record(err: unknown): void;
  /** The orderly shutdown; undefined until the process is up. */
  shutdown(): (() => Promise<void>) | undefined;
  exit(code: number): void;
  deadlineMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const CRASH_EXIT_CODE = 1;
export const CRASH_SHUTDOWN_DEADLINE_MS = 10_000;

export function crashExitHandler(deps: CrashExitDeps): (err: unknown) => void {
  let exiting = false;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  return (err) => {
    try {
      deps.record(err);
    } catch {
      /* recording must never stop the exit */
    }
    if (exiting) {
      deps.exit(CRASH_EXIT_CODE);
      return;
    }
    exiting = true;
    const shutdown = deps.shutdown();
    if (!shutdown) {
      deps.exit(CRASH_EXIT_CODE);
      return;
    }
    setTimer(() => deps.exit(CRASH_EXIT_CODE), deps.deadlineMs ?? CRASH_SHUTDOWN_DEADLINE_MS);
    shutdown().then(
      () => deps.exit(CRASH_EXIT_CODE),
      () => deps.exit(CRASH_EXIT_CODE),
    );
  };
}
