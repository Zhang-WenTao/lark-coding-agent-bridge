import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { answerTopic, finalCardText, hasTable, needsHeader, renderFinalCard } from '../../../src/card/final-card';
import { finalAnswerState, initialState, reduce, type RunState } from '../../../src/card/run-state';
import { getFinalCardPreference, type AppConfig } from '../../../src/config/schema';

const OPTS = { botName: 'Paloma', headerTemplate: 'violet' as const };
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };
const run = (events: AgentEvent[]): RunState => events.reduce(reduce, initialState);
const answer = (text: string): RunState => run([{ type: 'text', delta: text }, done]);

interface Card {
  config: { summary: { content: string }; streaming_mode?: boolean };
  header?: { template: string; title: { content: string }; icon?: unknown };
  body: { elements: Array<{ tag: string; content?: string; text_size?: string }> };
}
const render = (state: RunState, opts: Partial<Parameters<typeof renderFinalCard>[1]> = {}): Card =>
  renderFinalCard(state, { ...OPTS, ...opts }) as Card;

const TABLE = ['| 区域 | Pod 数 |', '|---|---|', '| prod-eur | 12 |'].join('\n');
const LONG = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join('\n');

describe('final card', () => {
  it('shows a short answer as bare text: no header, buttons, byline or streaming', () => {
    const card = render(answer('prod-eur 没有异常重启的 pod。'));
    expect(card.header).toBeUndefined();
    expect(card.config.streaming_mode).toBeUndefined();
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: 'prod-eur 没有异常重启的 pod。' }]);
    expect(card.config.summary.content).toBe('prod-eur 没有异常重启的 pod。');
    const json = JSON.stringify(card);
    for (const absent of ['button', 'Agent:', 'Model:', 'Sponsor', 'Usage', 'hr']) expect(json).not.toContain(absent);
  });

  it('adds a header bar in the configured colour, titled with the topic, for a long answer or a table', () => {
    const long = render(answer(LONG));
    expect(long.header).toEqual({ template: 'violet', title: { tag: 'plain_text', content: '第 1 行' } });

    const table = render(answer(`三个区的对比：\n\n${TABLE}`), { headerTemplate: 'green' });
    expect(table.header).toEqual({ template: 'green', title: { tag: 'plain_text', content: '三个区的对比' } });
    // The opening sentence stays in the body: it is the answer, not a heading.
    expect(table.body.elements[0]?.content?.startsWith('三个区的对比：')).toBe(true);
  });

  it('falls back to the bot name when the answer opens with a table', () => {
    expect(render(answer(TABLE)).header?.title.content).toBe('Paloma');
  });

  it('puts the configured avatar in the header, and nowhere on a short answer', () => {
    const icon = { tag: 'custom_icon', img_key: 'img_v3_avatar' };
    expect(render(answer(LONG), { headerIcon: 'img_v3_avatar' }).header?.icon).toEqual(icon);
    expect(render(answer(LONG)).header?.icon).toBeUndefined();
    expect(JSON.stringify(render(answer('ok'), { headerIcon: 'img_v3_avatar' }))).not.toContain('img_v3_avatar');
  });

  it('takes the title from a leading heading and leaves it out of the body', () => {
    const card = render(answer(`## antelope 三区对比\n\n${TABLE}`));
    expect(card.header?.title.content).toBe('antelope 三区对比');
    expect(card.body.elements[0]?.content?.startsWith('| 区域')).toBe(true);
  });

  it('reads a short topic off the answer', () => {
    expect(answerTopic('## 三个生产区 Pod 与发布对比\n\n正文')).toEqual({ title: '三个生产区 Pod 与发布对比', rest: '正文' });
    expect(answerTopic('**prod-us 落后两个版本**。其余正常')?.title).toBe('prod-us 落后两个版本');
    expect(answerTopic('- 先看结论：都正常')?.title).toBe('先看结论');
    // A long opening sentence is cut at its first comma, then to the title
    // limit — at a word boundary, never inside `pod`.
    expect(answerTopic('三个生产区里只有 prod-us 有一个 pod 处于 Pending 状态，原因是节点资源不足，其余都正常。')?.title).toBe(
      '三个生产区里只有 prod-us 有一个…',
    );
    expect(answerTopic(TABLE)).toBeUndefined();
    expect(answerTopic('```\ncode\n```')).toBeUndefined();
  });

  it('decides on the header by the answer itself', () => {
    expect(needsHeader('一行')).toBe(false);
    expect(needsHeader(Array.from({ length: 6 }, () => 'x').join('\n\n'))).toBe(false);
    expect(needsHeader(LONG)).toBe(true);
    expect(hasTable(TABLE)).toBe(true);
    expect(hasTable('```\n|---|---|\n```')).toBe(false);
    expect(hasTable('a --- b')).toBe(false);
  });

  it('carries only the answer the run ends on, without the bridge notes', () => {
    const state = run([
      { type: 'text', delta: '我先看一下。' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'kubectl get pods' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'account', label: 'b', switchedFrom: 'a' },
      { type: 'text', delta: '都正常。' },
      done,
    ]);
    const card = render(finalAnswerState(state));
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: '都正常。' }]);
  });

  it('says how a run that did not finish ended in one small grey line', () => {
    const failed = render(run([{ type: 'text', delta: '查到一半' }, { type: 'error', message: `boom\n${'x'.repeat(500)}`, terminationReason: 'failed' }]));
    const note = failed.body.elements.at(-1)!;
    expect(note.text_size).toBe('notation');
    expect(note.content).toContain("<font color='grey'>");
    expect(note.content).toContain('boom');
    expect(note.content!.length).toBeLessThan(160);
    expect(note.content).not.toContain('\n');

    const stopped = render(run([{ type: 'done', terminationReason: 'interrupted' }]));
    expect(stopped.body.elements).toHaveLength(1);
    expect(stopped.body.elements[0]?.content).toContain('中断');

    const paused = render(run([{ type: 'rate_limit', blocked: true, limitType: 'five_hour', at: 1 }, done]));
    expect(paused.body.elements[0]?.content).not.toContain('\n');
  });

  it('adds the model footer only when asked', () => {
    expect(JSON.stringify(render(answer('ok')))).not.toContain('Opus');
    const card = render(answer('ok'), { footerModel: 'Opus 5.5' });
    expect(card.body.elements.at(-1)).toEqual({
      tag: 'markdown',
      content: "<font color='grey'>Opus 5.5</font>",
      text_size: 'notation',
    });
  });

  it('has nothing to send for an empty answer, and a plain-text fallback otherwise', () => {
    expect(renderFinalCard(run([done]), OPTS)).toBeUndefined();
    const failed = run([{ type: 'text', delta: '一半' }, { type: 'error', message: 'boom', terminationReason: 'failed' }]);
    expect(finalCardText(failed)).toContain('一半');
    expect(finalCardText(failed)).toContain('boom');
  });

  it('masks raw email addresses like every other card', () => {
    expect(JSON.stringify(render(answer('联系 someone@example.com')))).not.toContain('someone@example.com');
  });
});

describe('finalCard preference', () => {
  const cfg = (finalCard: unknown): AppConfig => ({ preferences: { finalCard } }) as unknown as AppConfig;

  it('defaults to a violet header, no icon and no footer', () => {
    expect(getFinalCardPreference(cfg(undefined))).toEqual({ headerTemplate: 'violet', footer: false });
  });

  it('takes the header icon image key, ignoring a blank one', () => {
    expect(getFinalCardPreference(cfg({ headerIcon: ' img_v3_x ' })).headerIcon).toBe('img_v3_x');
    expect(getFinalCardPreference(cfg({ headerIcon: '  ' })).headerIcon).toBeUndefined();
  });

  it('keeps a known colour and falls back on an unknown one', () => {
    expect(getFinalCardPreference(cfg({ headerTemplate: 'purple', footer: true }))).toEqual({
      headerTemplate: 'purple',
      footer: true,
    });
    expect(getFinalCardPreference(cfg({ headerTemplate: '#6A2BFF' })).headerTemplate).toBe('violet');
  });
});
