import { beforeEach, describe, expect, it, vi } from 'vitest';

const classifyMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/agent/auto-effort', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/auto-effort')>();
  return { ...actual, classify: classifyMock };
});

import { AutoEffortStore, resolveAutoEffort } from '../../../src/agent/auto-effort';
import { autoEffortByline, startAutoEffort, type StartAutoEffortInput } from '../../../src/bot/auto-effort-flow';

const settings = resolveAutoEffort({ enabled: true })!;

function plan(store: AutoEffortStore, over: Partial<StartAutoEffortInput> = {}) {
  return startAutoEffort({
    settings,
    store,
    scope: 'p2p:ou_owner',
    texts: ['帮我查一下 staging-sea 这台设备为什么没有 0x10 数据'],
    attachments: 0,
    chatType: 'p2p',
    owner: true,
    cap: 'high',
    classify: { cwd: '/tmp/auto-effort-test', env: () => ({}) },
    now: () => 1_000,
    ...over,
  });
}

describe('startAutoEffort', () => {
  beforeEach(() => {
    classifyMock.mockReset();
  });

  it('starts a new conversation on the rated rung, then climbs one rung per message', async () => {
    const store = new AutoEffortStore();
    classifyMock.mockResolvedValue({ rung: 2, reason: '多系统排障' });
    const first = plan(store);
    const a = await first.pick(undefined, false);
    expect(a).toMatchObject({ label: 'xhigh', model: 'opus', effort: 'xhigh', via: 'fresh', reason: '多系统排障' });
    first.finish({ handle: 'sess-1', terminal: 'done', durationMs: 60_000 });

    classifyMock.mockResolvedValue({ rung: 3 });
    const second = plan(store, { texts: ['还是不对，换个思路彻底查一下根因'] });
    const b = await second.pick('sess-1', false);
    expect(b).toMatchObject({ label: 'max', model: 'opus', effort: 'max', via: 'up', from: 'xhigh' });
    expect(autoEffortByline(b!)).toBe('max（自动↑）');
    second.finish({ handle: 'sess-1', terminal: 'done', durationMs: 60_000 });

    // max is the top of the automatic ladder: Fable needs `/fable`.
    classifyMock.mockResolvedValue({ rung: 4 });
    const third = plan(store, { texts: ['还是不行，再深入一层把整个链路查透'] });
    expect(await third.pick('sess-1', false)).toMatchObject({ label: 'max', via: 'stay' });
    // The rating saw where the conversation stood.
    expect(classifyMock.mock.calls[1]![1]).toMatchObject({ current: 'xhigh', last: { terminal: 'done' } });
  });

  it('keeps the rung on a short follow-up without rating it', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 2, downVotes: 0, handle: 'sess-1' });
    const p = plan(store, { texts: ['继续'] });
    expect(await p.pick('sess-1', false)).toMatchObject({ label: 'xhigh', via: 'stay' });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('starts a short opener at the bottom', async () => {
    const p = plan(new AutoEffortStore(), { texts: ['你好'] });
    expect(await p.pick(undefined, false)).toMatchObject({ label: 'medium', via: 'fresh' });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('starts over when the conversation changed', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 3, downVotes: 0, handle: 'sess-old' });
    classifyMock.mockResolvedValue({ rung: 1 });
    expect(await plan(store).pick(undefined, false)).toMatchObject({ label: 'high', via: 'fresh' });
  });

  it('caps runs the owner did not start at the chat effort', async () => {
    const store = new AutoEffortStore();
    store.set('group:oc_x', { rung: 1, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue({ rung: 3 });
    const p = plan(store, { scope: 'group:oc_x', owner: false, chatType: 'group' });
    expect(await p.pick('sess-1', false)).toMatchObject({ label: 'high', via: 'stay' });
  });

  it('pins a /<rung> prefix and flags it for the agent', async () => {
    const store = new AutoEffortStore();
    const p = plan(store, { texts: ['/fable 设计一下新的账户调度'] });
    expect(p.forcedLabel).toBe('fable');
    expect(await p.pick(undefined, false)).toMatchObject({ label: 'fable', via: 'forced' });
    expect(classifyMock).not.toHaveBeenCalled();
    const m = plan(new AutoEffortStore(), { texts: ['/max 设计一下新的账户调度'] });
    expect(await m.pick(undefined, false)).toMatchObject({ label: 'max', model: 'opus', effort: 'max', via: 'forced' });
  });

  it('reads the prefix behind an image posted ahead of the text', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 4, downVotes: 0, handle: 'sess-1' });
    const p = plan(store, { texts: ['![image](img_v3_x)\n/high 怎么现在是 Fable 模型的'], attachments: 1 });
    expect(p.forcedLabel).toBe('high');
    expect(await p.pick('sess-1', false)).toMatchObject({ label: 'high', model: 'opus', via: 'forced' });
  });

  it('keeps Fable for a short follow-up of a /fable run, and leaves it for anything else', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 4, downVotes: 0, handle: 'sess-1' });
    expect(await plan(store, { texts: ['继续'] }).pick('sess-1', false)).toMatchObject({ label: 'fable', via: 'stay' });
    classifyMock.mockResolvedValue({ rung: 3 });
    expect(await plan(store).pick('sess-1', false)).toMatchObject({ label: 'max', model: 'opus' });
  });

  it('skips Fable for a while after a run on it failed or paused', async () => {
    for (const terminal of ['error', 'paused']) {
      const store = new AutoEffortStore();
      const failed = plan(store, { texts: ['/fable 设计一下新的账户调度'] });
      expect((await failed.pick(undefined, false))?.label).toBe('fable');
      failed.finish({ handle: 'sess-1', terminal, durationMs: 5_000 });
      // Even `/fable` lands on max while Fable is blocked.
      expect((await plan(store, { texts: ['/fable 再来'] }).pick('sess-1', false))?.label).toBe('max');
    }
  });

  it('leaves the rung alone when the message joins a live process', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 0, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue({ rung: 3 });
    expect(await plan(store).pick('sess-1', true)).toMatchObject({ label: 'medium', via: 'stay' });
  });

  it('keeps the current rung when the rating fails', async () => {
    const store = new AutoEffortStore();
    store.set('p2p:ou_owner', { rung: 1, downVotes: 0, handle: 'sess-1' });
    classifyMock.mockResolvedValue(undefined);
    expect(await plan(store).pick('sess-1', false)).toMatchObject({ label: 'high', via: 'stay' });
  });
});

describe('startAutoEffort Fable quota', () => {
  beforeEach(() => {
    classifyMock.mockReset();
  });

  it('skips Fable while its own weekly window is past the line on the run account', async () => {
    const store = new AutoEffortStore();
    const texts = ['/fable 设计一下新的账户调度'];
    const full = plan(store, { texts, windowUsed: (kind) => (kind === 'seven_day_fable' ? 92 : undefined) });
    expect((await full.pick(undefined, false))?.label).toBe('max');
    const room = plan(store, { texts, windowUsed: () => 40 });
    expect((await room.pick(undefined, false))?.label).toBe('fable');
    const unknown = plan(store, { texts, windowUsed: () => undefined });
    expect((await unknown.pick(undefined, false))?.label).toBe('fable');
  });
});
