import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { corruptStateNotice, notifyCorruptStateFiles } from '../../../src/bot/state-file-notice';

describe('sessions.json / workspaces.json corruption', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'state-corrupt-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const [name, make] of [
    ['sessions.json', (p: string) => new SessionStore(p)],
    ['workspaces.json', (p: string) => new WorkspaceStore(p)],
  ] as const) {
    it(`${name}: unparseable file is moved aside, store starts empty and reports once`, async () => {
      const path = join(dir, name);
      await writeFile(path, '{"oc_1": {"sessionId": "s", ');
      const store = make(path);
      await expect(store.load()).resolves.toBeUndefined();
      const problem = store.takeLoadProblem();
      expect(problem?.path).toBe(path);
      expect(problem?.movedTo).toMatch(new RegExp(`${name.replace('.', '\\.')}\\.corrupt-\\d+$`));
      expect(await readFile(problem!.movedTo, 'utf8')).toBe('{"oc_1": {"sessionId": "s", ');
      expect(store.takeLoadProblem()).toBeUndefined();
      expect(await readdir(dir)).toEqual([expect.stringMatching(/\.corrupt-\d+$/)]);
    });

    it(`${name}: a readable valid file reports nothing`, async () => {
      const path = join(dir, name);
      await writeFile(path, '{}');
      const store = make(path);
      await store.load();
      expect(store.takeLoadProblem()).toBeUndefined();
    });

    for (const body of ['null', '[]', '"x"']) {
      it(`${name}: valid JSON that is not an object (${body}) starts empty without failing`, async () => {
        const path = join(dir, name);
        await writeFile(path, body);
        const store = make(path);
        await expect(store.load()).resolves.toBeUndefined();
        expect(store.takeLoadProblem()).toBeUndefined();
      });
    }

    it(`${name}: an unreadable file still refuses to start and is left in place`, async () => {
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const path = join(dir, name);
      await writeFile(path, '{}');
      await chmod(path, 0o000);
      await expect(make(path).load()).rejects.toThrow();
      expect(await readdir(dir)).toEqual([name]);
    });
  }

  it('DMs the owner once per moved file, and only logs without an owner', async () => {
    const send = vi.fn(async () => ({}));
    const problem = { path: '/p/sessions.json', movedTo: '/p/sessions.json.corrupt-1', error: 'SyntaxError: x' };
    notifyCorruptStateFiles({ send }, 'ou_owner', [problem, undefined]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('ou_owner', { markdown: corruptStateNotice(problem) });
    expect(corruptStateNotice(problem)).toContain('/p/sessions.json.corrupt-1');
    send.mockClear();
    notifyCorruptStateFiles({ send }, undefined, [problem]);
    expect(send).not.toHaveBeenCalled();
  });
});
