import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../../../src/platform/file-lock.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('withFileLock', () => {
  it('runs one holder at a time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-lock-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    const steps: string[] = [];
    const hold = (name: string) =>
      withFileLock(file, async () => {
        steps.push(`${name}:in`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        steps.push(`${name}:out`);
        return name;
      });
    expect(await Promise.all([hold('a'), hold('b')])).toEqual(['a', 'b']);
    expect(steps).toHaveLength(4);
    expect(steps[0]!.split(':')[0]).toBe(steps[1]!.split(':')[0]);
    expect(steps[2]!.split(':')[0]).toBe(steps[3]!.split(':')[0]);
  });

  it('releases the lock when the holder throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcb-lock-'));
    dirs.push(dir);
    const file = join(dir, 'state.json');
    await expect(withFileLock(file, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withFileLock(file, async () => 'again')).toBe('again');
  });
});
