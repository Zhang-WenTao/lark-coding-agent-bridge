import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryTracker, entryTurnsPath, parseVisit, visitQuerySql } from '../../../src/bot/entry-tracker';
import { type RunContext, runContextPath, writeRunContext } from '../../../src/bot/run-context';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';

const ok = (rows: unknown[]) => JSON.stringify({ ok: true, identity: 'user', data: rows });

function ctxOf(over: Partial<RunContext> = {}): RunContext {
  return {
    scope: 'oc_p2p', chatId: 'oc_p2p', mode: 'p2p', ownerRun: false, publicDm: true,
    senders: [{ openId: 'ou_abc', name: '张三', type: 'user' }],
    messageIds: ['om_1'], updatedAt: '2026-11-24T03:00:00.000Z', ...over,
  };
}

describe('entry tracker', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entry-'));
    saved = process.env.LARK_CHANNEL_RUN_CONTEXT_DIR;
    delete process.env.LARK_CHANNEL_RUN_CONTEXT_DIR;
  });
  afterEach(() => { if (saved) process.env.LARK_CHANNEL_RUN_CONTEXT_DIR = saved; });

  it('builds a safe query and refuses odd ids', () => {
    expect(visitQuerySql('alice_visit', 'ou_abc123', 120)).toContain("occam_open_id = 'ou_abc123'");
    expect(visitQuerySql('alice_visit', 'ou_abc123', 120)).toContain("interval '120 minutes'");
    expect(() => visitQuerySql('alice_visit', "ou_x' OR '1'='1", 120)).toThrow();
    expect(() => visitQuerySql('a;drop', 'ou_x', 120)).toThrow();
  });

  it('parses the newest visit', () => {
    expect(parseVisit(ok([{ source: 'alice', _created_at: '2026-11-24T11:21:58.267+08:00' }]))).toEqual({
      source: 'alice', visitedAt: '2026-11-24T03:21:58.267Z',
    });
    expect(parseVisit(ok([]))).toBeUndefined();
    expect(parseVisit('not json')).toBeUndefined();
    expect(parseVisit(JSON.stringify({ ok: false }))).toBeUndefined();
  });

  it('caches hits until the window ends and misses for a minute; failures are not cached', async () => {
    let now = Date.parse('2026-11-24T03:30:00Z');
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom', timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: ok([]), stderr: '', timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: ok([{ source: 'alice', _created_at: '2026-11-24T03:29:00Z' }]), stderr: '', timedOut: false });
    const t = new EntryTracker({ miaodaAppId: 'app_x', windowMinutes: 120 }, { exec, env: () => ({}), appDir: dir, now: () => now });
    expect(await t.lookup('ou_abc')).toBeUndefined(); // failure
    expect(await t.lookup('ou_abc')).toBeUndefined(); // miss, cached
    expect(await t.lookup('ou_abc')).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
    now += 61_000;
    expect((await t.lookup('ou_abc'))?.source).toBe('alice');
    now += 60 * 60_000;
    expect((await t.lookup('ou_abc'))?.source).toBe('alice');
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[0][0]).toEqual(expect.arrayContaining(['apps', '+db-execute', '--app-id', 'app_x', '--as', 'user', '--yes']));
  });

  it('tags a private turn: patches run-context and logs the turn', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: ok([{ source: 'alice', _created_at: '2026-11-24T02:59:00Z' }]), stderr: '', timedOut: false });
    const t = new EntryTracker({ miaodaAppId: 'app_x' }, { exec, env: () => ({}), appDir: dir, now: () => Date.parse('2026-11-24T03:00:00Z') });
    const ctx = ctxOf();
    writeRunContext(dir, ctx);
    t.tagTurn(ctx);
    await vi.waitFor(() => expect(existsSync(entryTurnsPath(dir))).toBe(true));
    const file = JSON.parse(readFileSync(runContextPath(dir, ctx.scope), 'utf8'));
    expect(file.entry).toEqual({ source: 'alice', visitedAt: '2026-11-24T02:59:00.000Z' });
    const line = JSON.parse(readFileSync(entryTurnsPath(dir), 'utf8').trim());
    expect(line).toMatchObject({ openId: 'ou_abc', name: '张三', source: 'alice', scope: 'oc_p2p', messageIds: ['om_1'] });
  });

  it('leaves a newer batch alone and ignores group turns', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: ok([{ source: 'alice', _created_at: '2026-11-24T02:59:00Z' }]), stderr: '', timedOut: false });
    const t = new EntryTracker({ miaodaAppId: 'app_x' }, { exec, env: () => ({}), appDir: dir, now: () => Date.parse('2026-11-24T03:00:00Z') });
    const ctx = ctxOf();
    writeRunContext(dir, { ...ctx, messageIds: ['om_2'] }); // a newer batch already wrote the file
    t.tagTurn(ctx);
    await vi.waitFor(() => expect(existsSync(entryTurnsPath(dir))).toBe(true));
    expect(JSON.parse(readFileSync(runContextPath(dir, ctx.scope), 'utf8')).entry).toBeUndefined();
    t.tagTurn(ctxOf({ mode: 'group', scope: 'oc_g' }));
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('normalizes access.entryTracking', () => {
    const app = { id: 'cli_test', secret: 'sec', tenant: 'feishu' as const };
    const pick = (et: unknown) =>
      normalizeProfileConfig({ schemaVersion: 2, agentKind: 'claude', accounts: { app }, access: { entryTracking: et } }).access.entryTracking;
    expect(pick({ miaodaAppId: 'app_17jnuzasv3e', windowMinutes: 90 })).toEqual({ miaodaAppId: 'app_17jnuzasv3e', windowMinutes: 90 });
    expect(pick({ miaodaAppId: 'cli_x' })).toBeUndefined();
    expect(pick({ miaodaAppId: 'app_x', table: 'x;y', windowMinutes: 0 })).toEqual({ miaodaAppId: 'app_x' });
  });
});
