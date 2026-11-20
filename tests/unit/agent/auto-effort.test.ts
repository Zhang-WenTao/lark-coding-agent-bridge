import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutoEffortStore,
  DEFAULT_AUTO_EFFORT_LADDER,
  MODEL_BLOCK_MS,
  allowedRungs,
  classifierUserPrompt,
  decideRung,
  forcedRung,
  isShortFollowUp,
  parseClassifierAnswer,
  resolveAutoEffort,
} from '../../../src/agent/auto-effort';

const ladder = DEFAULT_AUTO_EFFORT_LADDER;
// medium, high, xhigh, max climb automatically; fable (4) is reached only by `/fable`.
const all = [0, 1, 2, 3];
const withFable = [0, 1, 2, 3, 4];

describe('allowedRungs', () => {
  it('lets the owner climb the whole automatic ladder', () => {
    expect(allowedRungs(ladder, { owner: true, cap: 'high' })).toEqual(all);
  });

  it('keeps the manual Fable rung out unless it is the one named', () => {
    expect(allowedRungs(ladder, { owner: true })).toEqual(all);
    expect(allowedRungs(ladder, { owner: true, manual: 4 })).toEqual(withFable);
    // Fable is owner-only: naming it does not open it to anyone else.
    expect(allowedRungs(ladder, { owner: false, cap: 'max', manual: 4 })).toEqual(all);
  });

  it('caps everyone else at the chat effort and keeps them off owner-only rungs', () => {
    expect(allowedRungs(ladder, { owner: false, cap: 'high' })).toEqual([0, 1]);
    expect(allowedRungs(ladder, { owner: false, cap: 'xhigh' })).toEqual([0, 1, 2]);
    expect(allowedRungs(ladder, { owner: false, cap: 'max' })).toEqual(all);
    expect(allowedRungs(ladder, { owner: false, cap: 'low' })).toEqual([]);
  });

  it('skips rungs whose model is blocked', () => {
    expect(allowedRungs(ladder, { owner: true, manual: 4, blockedModels: new Set(['fable']) })).toEqual(all);
  });
});

describe('decideRung', () => {
  it('starts a new conversation where the rating says, but never on another model', () => {
    expect(decideRung({ ladder, allowed: all, target: 2 })).toEqual({ rung: 2, downVotes: 0, via: 'fresh' });
    expect(decideRung({ ladder, allowed: all, target: 3 }).rung).toBe(3);
    expect(decideRung({ ladder, allowed: withFable, target: 4 }).rung).toBe(3);
    expect(decideRung({ ladder, allowed: all }).rung).toBe(0);
    expect(decideRung({ ladder, allowed: [0, 1], target: 2 }).rung).toBe(1);
  });

  it('climbs straight to the rated rung', () => {
    expect(decideRung({ ladder, allowed: all, current: { rung: 0, downVotes: 0 }, target: 3 })).toEqual({
      rung: 3,
      downVotes: 0,
      via: 'up',
    });
    expect(decideRung({ ladder, allowed: all, current: { rung: 0, downVotes: 0 }, target: 2 }).rung).toBe(2);
    expect(decideRung({ ladder, allowed: all, current: { rung: 2, downVotes: 0 }, target: 3 }).rung).toBe(3);
    // Up to the highest allowed rung under the rating.
    expect(decideRung({ ladder, allowed: [0, 2], current: { rung: 0, downVotes: 0 }, target: 3 }).rung).toBe(2);
  });

  it('drops one rung at a time', () => {
    expect(decideRung({ ladder, allowed: all, current: { rung: 2, downVotes: 0 }, target: 0 })).toEqual({
      rung: 1,
      downVotes: 0,
      via: 'down',
    });
  });

  it('climbs to max but no further on its own', () => {
    expect(decideRung({ ladder, allowed: all, current: { rung: 3, downVotes: 0 }, target: 3 }).via).toBe('stay');
    expect(decideRung({ ladder, allowed: all, current: { rung: 3, downVotes: 0 }, target: 0 }).rung).toBe(2);
  });

  it('leaves a rung with its own model only after two ratings below it in a row', () => {
    const first = decideRung({ ladder, allowed: withFable, current: { rung: 4, downVotes: 0 }, target: 1 });
    expect(first).toEqual({ rung: 4, downVotes: 1, via: 'held' });
    const second = decideRung({ ladder, allowed: withFable, current: { rung: 4, downVotes: first.downVotes }, target: 1 });
    expect(second).toEqual({ rung: 3, downVotes: 0, via: 'down' });
  });

  it('leaves Fable at once when the run no longer allows it (no /fable on this message)', () => {
    expect(decideRung({ ladder, allowed: all, current: { rung: 4, downVotes: 0 }, target: 1 })).toEqual({
      rung: 2,
      downVotes: 0,
      via: 'down',
    });
  });

  it('stays put when the rating failed or matches', () => {
    expect(decideRung({ ladder, allowed: all, current: { rung: 2, downVotes: 1 } })).toEqual({
      rung: 2,
      downVotes: 0,
      via: 'stay',
    });
    expect(decideRung({ ladder, allowed: all, current: { rung: 1, downVotes: 0 }, target: 1 }).via).toBe('stay');
  });

  it('stays at the top and bottom of what is allowed', () => {
    expect(decideRung({ ladder, allowed: [0, 1], current: { rung: 1, downVotes: 0 }, target: 3 })).toEqual({
      rung: 1,
      downVotes: 0,
      via: 'stay',
    });
    expect(decideRung({ ladder, allowed: all, current: { rung: 0, downVotes: 0 }, target: 0 }).rung).toBe(0);
  });

  it('pulls a rung that is no longer allowed down to the highest allowed one', () => {
    // Fable got blocked (or was not named) mid-conversation: continue from max.
    expect(decideRung({ ladder, allowed: all, current: { rung: 4, downVotes: 0 }, target: 3 }).rung).toBe(3);
  });

  it('pins a forced rung, within what is allowed', () => {
    expect(decideRung({ ladder, allowed: withFable, current: { rung: 0, downVotes: 0 }, forced: 4 })).toEqual({
      rung: 4,
      downVotes: 0,
      via: 'forced',
    });
    expect(decideRung({ ladder, allowed: all, forced: 3 })).toEqual({ rung: 3, downVotes: 0, via: 'forced' });
    expect(decideRung({ ladder, allowed: [0, 1], forced: 3 }).rung).toBe(1);
  });
});

describe('forcedRung', () => {
  it('reads a /<label> prefix', () => {
    expect(forcedRung(ladder, '/fable 帮我设计一下')).toBe(4);
    expect(forcedRung(ladder, '/max 帮我设计一下')).toBe(3);
    expect(forcedRung(ladder, '  /HIGH')).toBe(1);
    expect(forcedRung(ladder, '/xhigh\n看下这个')).toBe(2);
  });

  it('sees the prefix behind images or files posted ahead of the text', () => {
    expect(forcedRung(ladder, '![image](img_v3_abc-123)\n/high 怎么现在是 Fable')).toBe(1);
    expect(forcedRung(ladder, '![image](img_a) ![image](img_b) /fable 看图')).toBe(4);
    expect(forcedRung(ladder, '[report.pdf](file_v3_x)\n/xhigh')).toBe(2);
    expect(forcedRung(ladder, '![image](img_a)\n看下 /high')).toBeUndefined();
  });

  it('ignores anything else', () => {
    expect(forcedRung(ladder, '/fables 不是档位')).toBeUndefined();
    expect(forcedRung(ladder, '/deploy sea')).toBeUndefined();
    expect(forcedRung(ladder, '用 /fable 看看')).toBeUndefined();
  });
});

describe('isShortFollowUp', () => {
  it('counts short text without attachments', () => {
    expect(isShortFollowUp(' 继续 ', 0)).toBe(true);
    expect(isShortFollowUp('好的，按推荐做', 0)).toBe(false);
    expect(isShortFollowUp('看图', 1)).toBe(false);
  });
});

describe('parseClassifierAnswer', () => {
  it('finds the JSON in the answer', () => {
    expect(parseClassifierAnswer(ladder, '```json\n{"level":"xhigh","reason":"跨模块根因分析"}\n```')).toEqual({
      rung: 2,
      reason: '跨模块根因分析',
    });
    expect(parseClassifierAnswer(ladder, '{"level":" High "}')).toEqual({ rung: 1 });
  });

  it('rejects unknown levels and broken JSON', () => {
    expect(parseClassifierAnswer(ladder, '{"level":"ultra"}')).toBeUndefined();
    // The rating may not pick a manual rung.
    expect(parseClassifierAnswer(ladder, '{"level":"fable"}')).toBeUndefined();
    expect(parseClassifierAnswer(ladder, '{"level":"max"}')).toEqual({ rung: 3 });
    expect(parseClassifierAnswer(ladder, '{"level":')).toBeUndefined();
    expect(parseClassifierAnswer(ladder, 'high')).toBeUndefined();
  });
});

describe('classifierUserPrompt', () => {
  it('tells the rating where the conversation stands', () => {
    const fresh = classifierUserPrompt({ text: '查一下', chatType: 'p2p' });
    expect(fresh).toContain('新会话');
    expect(fresh).toContain('私聊');
    const ongoing = classifierUserPrompt({
      text: '还是不行',
      chatType: 'group',
      current: 'high',
      last: { terminal: 'error', durationMs: 7 * 60_000 },
      quoted: '上一条回复',
    });
    expect(ongoing).toContain('当前档位：high；上一轮用时 7 分钟，结果 error');
    expect(ongoing).toContain('上一条回复');
  });

  it('clips long messages', () => {
    const prompt = classifierUserPrompt({ text: 'x'.repeat(5000), chatType: 'p2p' });
    expect(prompt.length).toBeLessThan(3200);
    expect(prompt).toContain('已截断');
  });
});

describe('resolveAutoEffort', () => {
  it('is off unless enabled, and on Claude only', () => {
    expect(resolveAutoEffort(undefined)).toBeUndefined();
    expect(resolveAutoEffort({})).toBeUndefined();
    expect(resolveAutoEffort({ enabled: true }, 'codex')).toBeUndefined();
  });

  it('fills in the defaults', () => {
    const s = resolveAutoEffort({ enabled: true });
    expect(s?.ladder.map((r) => r.label)).toEqual(['medium', 'high', 'xhigh', 'max', 'fable']);
    expect(s?.ladder.map((r) => `${r.model}/${r.effort}`)).toEqual([
      'opus/medium',
      'opus/high',
      'opus/xhigh',
      'opus/max',
      'fable/xhigh',
    ]);
    expect(s?.ladder.filter((r) => r.manual).map((r) => r.label)).toEqual(['fable']);
    expect(s?.classifierModel).toBe('opus');
    expect(s?.classifierEffort).toBe('medium');
    expect(s?.timeoutMs).toBe(20_000);
  });

  it('falls back on a malformed ladder and clamps the timeout', () => {
    const s = resolveAutoEffort({
      enabled: true,
      ladder: [{ label: 'x', model: 'opus', effort: 'ultra' }],
      classifierEffort: 'ultra',
      timeoutMs: 999_999,
    });
    expect(s?.ladder).toHaveLength(5);
    expect(s?.classifierEffort).toBe('medium');
    expect(s?.timeoutMs).toBe(60_000);
  });

  it('keeps a valid custom ladder', () => {
    const s = resolveAutoEffort({
      enabled: true,
      ladder: [
        { label: 'low', model: 'sonnet', effort: 'low' },
        { label: 'top', model: 'opus', effort: 'max' },
      ],
    });
    expect(s?.ladder.map((r) => `${r.model}/${r.effort}`)).toEqual(['sonnet/low', 'opus/max']);
  });
});

describe('AutoEffortStore', () => {
  it('hands out a scope state only for the conversation it belongs to', () => {
    const store = new AutoEffortStore();
    store.set('s1', { rung: 2, downVotes: 0, handle: 'sess-a' });
    expect(store.forConversation('s1', 'sess-a')?.rung).toBe(2);
    expect(store.forConversation('s1', 'sess-b')).toBeUndefined();
    expect(store.forConversation('s1', undefined)).toBeUndefined();
  });

  it('blocks a model for a while', () => {
    const store = new AutoEffortStore();
    store.blockModel('fable', 1_000);
    expect(store.blockedModels(1_000 + MODEL_BLOCK_MS - 1).has('fable')).toBe(true);
    expect(store.blockedModels(1_000 + MODEL_BLOCK_MS).has('fable')).toBe(false);
  });

  it('survives a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'auto-effort-')), 'state.json');
    const store = new AutoEffortStore(path);
    store.set('s1', { rung: 3, downVotes: 1, handle: 'sess-a', last: { terminal: 'done', durationMs: 1000 } });
    await store.flush();
    const again = new AutoEffortStore(path);
    await again.load();
    expect(again.get('s1')).toMatchObject({ rung: 3, downVotes: 1, handle: 'sess-a' });
  });
});
