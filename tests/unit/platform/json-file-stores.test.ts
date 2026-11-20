import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelPinStore } from '../../../src/agent/model-pin.js';
import { CodeSnippetStore } from '../../../src/card/code-snippets.js';
import { NoteExposure } from '../../../src/knowledge/exposure.js';
import { JobStore } from '../../../src/scheduler/store.js';

// Stores on JsonFile: a file that is not JSON is moved aside at load (the
// store starts empty, as before) so the next save cannot overwrite the only copy.
describe('JSON state stores keep a corrupt file instead of overwriting it', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const cases: Array<[string, (path: string) => { load(): Promise<void>; flush(): Promise<void>; touchSave(): void }]> = [
    ['model-pin', (p) => {
      const s = new ModelPinStore(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => s.set('scope', 'sonnet') };
    }],
    ['code-snippets', (p) => {
      const s = new CodeSnippetStore(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => void s.put('echo hi') };
    }],
    ['exposure', (p) => {
      const s = new NoteExposure(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => s.record(['a']) };
    }],
    ['jobs', (p) => {
      const s = new JobStore(p);
      return {
        load: () => s.load(),
        flush: () => s.flush(),
        touchSave: () => void s.remove('none'),
      };
    }],
  ];

  for (const [name, make] of cases) {
    it(name, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'json-store-'));
      dirs.push(dir);
      const path = join(dir, 'state.json');
      await writeFile(path, '{not json');
      const store = make(path);
      await expect(store.load()).resolves.toBeUndefined();
      const files = await readdir(dir);
      const moved = files.find((f) => f.startsWith('state.json.corrupt-'));
      expect(moved).toBeDefined();
      expect(await readFile(join(dir, moved!), 'utf8')).toBe('{not json');
      store.touchSave();
      await store.flush();
      expect(await readFile(join(dir, moved!), 'utf8')).toBe('{not json');
    });
  }
});
