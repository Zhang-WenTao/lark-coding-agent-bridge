import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFile } from '../../../src/platform/json-file';

describe('JsonFile', () => {
  let dir: string;
  let loadErrors: Array<{ err: unknown; movedTo?: string }>;
  let persistErrors: unknown[];
  const make = (path: string | undefined, mode?: number) =>
    new JsonFile(path, {
      ...(mode === undefined ? {} : { mode }),
      now: () => 1700000000000,
      onLoadError: (err, movedTo) => loadErrors.push({ err, movedTo }),
      onPersistError: (err) => persistErrors.push(err),
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'json-file-'));
    loadErrors = [];
    persistErrors = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as no state, without reporting', async () => {
    expect(await make(join(dir, 'a.json')).load()).toBeUndefined();
    expect(loadErrors).toEqual([]);
  });

  it('round-trips what was written', async () => {
    const path = join(dir, 'a.json');
    const f = make(path);
    f.write(JSON.stringify({ x: 1 }));
    await f.flush();
    expect(await make(path).load()).toEqual({ x: 1 });
  });

  it('lands queued writes in order (last one wins)', async () => {
    const path = join(dir, 'a.json');
    const f = make(path);
    for (let i = 0; i < 20; i++) f.write(JSON.stringify({ i }));
    await f.flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ i: 19 });
  });

  it('writes with the requested mode (0600 by default)', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    make(a).write('{}');
    const fb = make(b, 0o644);
    fb.write('{}');
    await fb.flush();
    await make(a).flush();
    if (process.platform !== 'win32') {
      expect((await stat(a)).mode & 0o777).toBe(0o600);
      expect((await stat(b)).mode & 0o777).toBe(0o644);
    }
  });

  it('moves an unparseable file aside instead of letting the next write destroy it', async () => {
    const path = join(dir, 'a.json');
    await writeFile(path, '{"half": ');
    const f = make(path);
    expect(await f.load()).toBeUndefined();
    const moved = `${path}.corrupt-1700000000000`;
    expect(loadErrors).toHaveLength(1);
    expect(loadErrors[0]!.movedTo).toBe(moved);
    expect(await readFile(moved, 'utf8')).toBe('{"half": ');
    f.write('{}');
    await f.flush();
    expect((await readdir(dir)).sort()).toEqual(['a.json', 'a.json.corrupt-1700000000000']);
  });

  it('reports an unreadable file without moving it', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const path = join(dir, 'a.json');
    await writeFile(path, '{}');
    await chmod(path, 0o000);
    expect(await make(path).load()).toBeUndefined();
    expect(loadErrors).toHaveLength(1);
    expect(loadErrors[0]!.movedTo).toBeUndefined();
    expect(await readdir(dir)).toEqual(['a.json']);
  });

  it('reports a failed write and keeps the chain usable', async () => {
    const blocker = join(dir, 'sub');
    await writeFile(blocker, '');
    const f = make(join(blocker, 'a.json'));
    f.write('{"n":1}');
    await f.flush();
    expect(persistErrors).toHaveLength(1);
    await rm(blocker);
    f.write('{"n":2}');
    await f.flush();
    expect(persistErrors).toHaveLength(1);
    expect(JSON.parse(await readFile(join(blocker, 'a.json'), 'utf8'))).toEqual({ n: 2 });
  });

  it('is memory-only without a path', async () => {
    const f = make(undefined);
    f.write('{}');
    await f.flush();
    expect(await f.load()).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });
});
