import { describe, expect, it } from 'vitest';
import { fallbackBrief, planOwnerNotice } from '../../../src/card/owner-notify';
import { stripControlMarkers, initialState, type RunState } from '../../../src/card/run-state';
import { isOwnerNotifyChat, type AppConfig } from '../../../src/config/schema';
import { briefOf, stripBriefMarker } from '../../../src/session/brief-marker';
import { newSessionRequest } from '../../../src/session/smart-session';

describe('brief marker', () => {
  it('reads and strips a trailing brief', () => {
    const text = '巡检完成，详见下表。\n\n| a | b |\n\n[[BRIEF: 2 台双中心在线，需确认]]';
    expect(briefOf(text)).toBe('2 台双中心在线，需确认');
    expect(stripBriefMarker(text)).toBe('巡检完成，详见下表。\n\n| a | b |');
  });

  it('accepts a full-width colon and keeps the last brief', () => {
    expect(briefOf('[[BRIEF：先这样]]\n正文\n[[BRIEF：最终结论]]')).toBe('最终结论');
  });

  it('leaves NEW_SESSION readable whichever order the markers come in', () => {
    const before = '完成\n[[BRIEF: 已完成]]\n[[NEW_SESSION: 做完了]]';
    const after = '完成\n[[NEW_SESSION: 做完了]]\n[[BRIEF: 已完成]]';
    expect(newSessionRequest(stripBriefMarker(before))).toEqual({ summary: '做完了' });
    expect(newSessionRequest(stripBriefMarker(after))).toEqual({ summary: '做完了' });
  });

  it('hides a marker still streaming in', () => {
    expect(stripBriefMarker('正文\n[[BRIEF: 已', true)).toBe('正文');
    expect(stripBriefMarker('正文\n[[BR', true)).toBe('正文');
    expect(stripBriefMarker('a [b]', true)).toBe('a [b]');
  });

  it('is stripped from what the card shows', () => {
    const state: RunState = { ...initialState, terminal: 'done', finalText: '结论\n[[BRIEF: 简述]]' };
    expect(stripControlMarkers(state).finalText).toBe('结论');
  });

  it('clips long briefs to one line', () => {
    const brief = briefOf(`[[BRIEF: ${'长'.repeat(200)}]]`)!;
    expect(brief.length).toBe(120);
    expect(brief.endsWith('…')).toBe(true);
  });
});

describe('fallbackBrief', () => {
  it('takes the first meaningful line without markdown', () => {
    expect(fallbackBrief('## **结论**：已完成 [PR](https://x)\n更多')).toBe('结论：已完成 PR');
    expect(fallbackBrief('\n---\n- 第一条')).toBe('第一条');
    expect(fallbackBrief('')).toBeUndefined();
  });
});

describe('planOwnerNotice', () => {
  const base = { ownerId: 'ou_owner', terminal: 'done' as const, answerText: '正文\n[[BRIEF: 搞定了]]' };

  it('@-mentions the owner with the brief', () => {
    const n = planOwnerNotice(base)!;
    expect(n.text).toBe('✅ 搞定了');
    expect(n.mentions.map((m) => m.openId)).toEqual(['ou_owner']);
  });

  it('adds human requesters once', () => {
    const n = planOwnerNotice({
      ...base,
      requesters: [{ openId: 'ou_owner' }, { openId: 'ou_b', name: 'B' }],
    })!;
    expect(n.mentions.map((m) => m.openId)).toEqual(['ou_owner', 'ou_b']);
  });

  it('falls back to the first line', () => {
    expect(planOwnerNotice({ ...base, answerText: '**周报已发出**\n详情' })!.text).toBe('✅ 周报已发出');
  });

  it('reports failures', () => {
    expect(planOwnerNotice({ ...base, terminal: 'error', answerText: undefined, error: 'boom' })!.text).toBe(
      '⚠️ 任务异常结束：boom',
    );
    expect(planOwnerNotice({ ...base, terminal: 'idle_timeout' })!.text).toContain('长时间无响应');
  });

  it('stays quiet for stopped, paused or empty runs', () => {
    expect(planOwnerNotice({ ...base, terminal: 'interrupted' })).toBeUndefined();
    expect(planOwnerNotice({ ...base, terminal: 'paused' })).toBeUndefined();
    expect(planOwnerNotice({ ...base, answerText: '[[NO_REPLY]]' })).toBeUndefined();
    expect(planOwnerNotice({ ...base, answerText: '  ' })).toBeUndefined();
  });
});

describe('isOwnerNotifyChat', () => {
  it('matches configured chats only', () => {
    const cfg = { preferences: { ownerNotifyChats: ['oc_a'] } } as unknown as AppConfig;
    expect(isOwnerNotifyChat(cfg, 'oc_a')).toBe(true);
    expect(isOwnerNotifyChat(cfg, 'oc_b')).toBe(false);
    expect(isOwnerNotifyChat({} as AppConfig, 'oc_a')).toBe(false);
  });
});
