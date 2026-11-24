import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runContextPath, writeRunContext } from '../../../src/bot/run-context';

describe('run context file', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.LARK_CHANNEL_RUN_CONTEXT_DIR; delete process.env.LARK_CHANNEL_RUN_CONTEXT_DIR; });
  afterEach(() => { if (saved) process.env.LARK_CHANNEL_RUN_CONTEXT_DIR = saved; });
  it('is stable per scope and rewritten with the latest sender', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runctx-'));
    const base = {
      scope: 'oc_a:omt_1', chatId: 'oc_a', mode: 'topic' as const, ownerRun: false, publicDm: false,
      messageIds: ['om_1'], updatedAt: '2026-11-24T00:00:00Z',
    };
    const p1 = writeRunContext(dir, { ...base, senders: [{ openId: 'ou_1', name: 'A' }] });
    const p2 = writeRunContext(dir, { ...base, senders: [{ openId: 'ou_2', name: 'B' }] });
    expect(p1).toBe(p2);
    expect(p1).toBe(runContextPath(dir, 'oc_a:omt_1'));
    expect(p1!.startsWith(join(dir, 'run-context'))).toBe(true);
    expect(JSON.parse(readFileSync(p1!, 'utf8')).senders[0].openId).toBe('ou_2');
    expect(runContextPath(dir, 'oc_b')).not.toBe(p1);
  });
});
