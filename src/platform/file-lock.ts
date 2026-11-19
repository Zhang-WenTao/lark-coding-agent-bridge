import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';

/**
 * Run `fn` holding a cross-process lock on `path` (via `<path>.lock`), so a
 * read-modify-write of a file shared by several processes (the daemons, the
 * CLI) cannot lose another writer's change. Waits about a second for a busy
 * lock, then throws rather than writing over it.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = `${path}.lock`;
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  await chmod(lockTarget, 0o600).catch(() => {});
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: 10,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
