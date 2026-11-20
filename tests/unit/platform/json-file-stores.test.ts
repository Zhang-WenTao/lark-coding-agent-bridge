import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelPinStore } from '../../../src/agent/model-pin.js';
import { CodeSnippetStore } from '../../../src/card/code-snippets.js';
import { NoteExposure } from '../../../src/knowledge/exposure.js';
import { JobStore } from '../../../src/scheduler/store.js';
import { AutoResumer } from '../../../src/bot/auto-resume.js';
import { ChatContextCursorStore } from '../../../src/bot/chat-context.js';
import { RunRegistry } from '../../../src/runtime/run-registry.js';
import { AutoEffortStore } from '../../../src/agent/auto-effort.js';
import { DreamStateStore } from '../../../src/dream/state.js';
import { CandidatePool } from '../../../src/dream/pool.js';
import { RecallStore } from '../../../src/dream/recall.js';
import { UsageLedger } from '../../../src/runtime/usage-ledger.js';

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
    ['usage-ledger', (p) => {
      const s = new UsageLedger(p);
      return {
        load: () => s.load(),
        flush: () => s.flush(),
        touchSave: () => s.record({ actorId: 'a', source: 'im', scopeId: 's', usage: { type: 'usage', inputTokens: 1 } as never }),
      };
    }],
    ['run-registry', (p) => {
      const s = new RunRegistry(p, 1);
      return {
        load: () => s.load(),
        flush: () => s.flush(),
        touchSave: () => s.start({ runId: 'r', scope: 's', chatId: 'c', originMessageId: 'm', promptPreview: 'p', startedAt: 1 }),
      };
    }],
    ['chat-context-cursor', (p) => {
      const s = new ChatContextCursorStore(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => s.advance('scope', 5) };
    }],
    ['auto-resume', (p) => {
      const s = new AutoResumer({ file: p, fire: async () => {} });
      let pending: Promise<void> = Promise.resolve();
      return {
        load: () => s.load(),
        flush: () => pending,
        touchSave: () => {
          pending = s.schedule({
            scope: 's', chatId: 'c', chatType: 'p2p', senderId: 'u', originMessageId: 'm', resumeAt: 1, attempt: 1, createdAt: 1,
          });
        },
      };
    }],
    ['auto-effort', (p) => {
      const s = new AutoEffortStore(p);
      return {
        load: () => s.load(),
        flush: () => s.flush(),
        touchSave: () => s.set('scope', { handle: 'h', level: 'low' } as never),
      };
    }],
    ['dream-state', (p) => {
      const s = new DreamStateStore(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => s.updateAuto({ consecutiveFailures: 1 }) };
    }],
    ['dream-pool', (p) => {
      const s = new CandidatePool(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => s.replace([]) };
    }],
    ['dream-recall', (p) => {
      const s = new RecallStore(p);
      return { load: () => s.load(), flush: () => s.flush(), touchSave: () => (s as unknown as { persist(): void }).persist() };
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

  it('auto-resume still rejects on an unreadable (non-ENOENT) file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-store-'));
    dirs.push(dir);
    // A directory where the file should be: readFile fails with EISDIR, which must not be swallowed.
    const s = new AutoResumer({ file: dir, fire: async () => {} });
    await expect(s.load()).rejects.toThrow();
  });

  it('dream-state rejects on an unreadable file, and a read-only viewer leaves a corrupt file in place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-store-'));
    dirs.push(dir);
    await expect(new DreamStateStore(dir).load()).rejects.toThrow();
    const path = join(dir, 'state.json');
    await writeFile(path, '{not json');
    await new DreamStateStore(path).load(Date.now(), { readOnly: true });
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});
