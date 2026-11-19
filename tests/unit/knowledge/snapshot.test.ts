import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KnowledgeContext } from '../../../src/knowledge/inject.js';
import { writeKnowledgeSnapshot } from '../../../src/knowledge/snapshot.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lcb-snap-'));
  dirs.push(dir);
  return dir;
}

const context = (version: string) => ({ version, profileMemory: ['m'] }) as unknown as KnowledgeContext;

describe('writeKnowledgeSnapshot', () => {
  it('writes a whole JSON file once per version', async () => {
    const dir = await tmp();
    const file = await writeKnowledgeSnapshot(dir, context('v1'));
    expect(file).toBe(join(dir, 'v1.json'));
    expect(JSON.parse(await readFile(file!, 'utf8'))).toMatchObject({ version: 'v1' });
    const old = new Date(Date.now() - 60_000);
    await utimes(file!, old, old);
    await writeKnowledgeSnapshot(dir, context('v1'));
    expect((await stat(file!)).mtimeMs).toBe(old.getTime());
    expect((await readdir(dir)).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('keeps the newest 40', async () => {
    const dir = await tmp();
    for (let i = 0; i < 41; i += 1) {
      await writeFile(join(dir, `old-${i}.json`), '{}');
      const at = new Date(Date.now() - (100 - i) * 1000);
      await utimes(join(dir, `old-${i}.json`), at, at);
    }
    await writeKnowledgeSnapshot(dir, context('v-new'));
    const names = await readdir(dir);
    expect(names).toHaveLength(40);
    expect(names).toContain('v-new.json');
    expect(names).not.toContain('old-0.json');
  });

  it('skips a context without a version', async () => {
    const dir = await tmp();
    expect(await writeKnowledgeSnapshot(dir, context(''))).toBeUndefined();
  });
});
