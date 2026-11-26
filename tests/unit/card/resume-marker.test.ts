import { describe, expect, it } from 'vitest';
import { renderFinalCard } from '../../../src/card/final-card.js';
import {
  resumeNotice,
  resumeRequestIn,
  resumeRequestOf,
  scheduledResumeInstruction,
  stripResumeMarkers,
} from '../../../src/card/resume-marker.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { finalAnswerState, initialState, stripControlMarkers, type RunState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import { formatMonthDayTime as formatMoment } from '../../../src/core/time-format.js';

const AT = new Date(2026, 10, 26, 18, 1, 30).getTime();

function done(blocks: RunState['blocks'], extra: Partial<RunState> = {}): RunState {
  return { ...initialState, blocks, terminal: 'done', footer: null, ...extra };
}

describe('[[RESUME_…]] grammar', () => {
  it('reads each form, with or without a ledger, in either colon and bar width', () => {
    expect(resumeRequestOf('先停。\n[[RESUME_AFTER: five_hour | /tmp/ledger.md]]')).toEqual({
      kind: 'after',
      window: 'five_hour',
      ledger: '/tmp/ledger.md',
    });
    expect(resumeRequestOf('[[RESUME_AFTER: five_hour]]')).toEqual({ kind: 'after', window: 'five_hour' });
    expect(resumeRequestOf('  [[RESUME_AT：2026-11-26T18:00 ｜ ~/work/plan.md]]  ')).toEqual({
      kind: 'at',
      time: '2026-11-26T18:00',
      ledger: '~/work/plan.md',
    });
    expect(resumeRequestOf('好的，先不做了。\n[[RESUME_CANCEL]]')).toEqual({ kind: 'cancel' });
  });

  it('takes the last marker when there are several', () => {
    expect(resumeRequestOf('[[RESUME_AT: 18:00]]\n改主意了\n[[RESUME_CANCEL]]')).toEqual({ kind: 'cancel' });
  });

  it('ignores markers written inline or inside fenced code', () => {
    expect(resumeRequestOf('在回复里写 `[[RESUME_AFTER: five_hour]]` 就行')).toBeUndefined();
    expect(resumeRequestOf('示例：\n```\n[[RESUME_AFTER: five_hour]]\n```\n完')).toBeUndefined();
    expect(resumeRequestOf('[[RESUME_LATER: five_hour]]')).toBeUndefined();
  });

  it('reads the whole run, notes before the last tool call and a reported final text included', () => {
    const early = done([
      { kind: 'text', content: '台账已更新。\n[[RESUME_AFTER: five_hour]]', streaming: false },
      { kind: 'tool', tool: { id: 't1', name: 'Bash', input: {}, status: 'done' } },
      { kind: 'text', content: '先停在这里。', streaming: false },
    ]);
    expect(resumeRequestIn(early)).toEqual({ kind: 'after', window: 'five_hour' });
    expect(resumeRequestIn(done([], { finalText: '[[RESUME_CANCEL]]' }))).toEqual({ kind: 'cancel' });
    // A line the bridge added itself is not the agent's.
    expect(resumeRequestIn(done([{ kind: 'text', content: '[[RESUME_CANCEL]]', streaming: false, note: 'supplement' }]))).toBeUndefined();
  });
});

describe('stripping', () => {
  it('drops marker lines and keeps the rest of the answer as written', () => {
    expect(stripResumeMarkers('先停在第 3 步。\n[[RESUME_AFTER: five_hour | /tmp/l.md]]\n')).toBe('先停在第 3 步。');
    expect(stripResumeMarkers('[[RESUME_CANCEL]]\n好的，不做了。')).toBe('好的，不做了。');
    const prose = '写 `[[RESUME_AT: 18:00]]` 即可\n```\n[[RESUME_CANCEL]]\n```';
    expect(stripResumeMarkers(prose)).toBe(prose);
  });

  it('hides a marker line still streaming in, but only while it streams', () => {
    expect(stripResumeMarkers('先停。\n[[RESUME_AF', true)).toBe('先停。');
    expect(stripResumeMarkers('先停。\n[[', true)).toBe('先停。');
    expect(stripResumeMarkers('先停。\n[[RESUME_AF')).toBe('先停。\n[[RESUME_AF');
    expect(stripResumeMarkers('数组 [1, 2', true)).toBe('数组 [1, 2');
  });

  it('is part of the control markers every reply mode strips', () => {
    const state = done(
      [{ kind: 'text', content: '[[TITLE: 升级进度]]\n第一阶段完成。\n[[RESUME_AFTER: five_hour]]', streaming: false }],
      { finalText: '第一阶段完成。\n[[RESUME_AFTER: five_hour]]' },
    );
    const shown = stripControlMarkers(state);
    expect(JSON.stringify(shown)).not.toContain('RESUME');
    expect(shown.title).toBe('升级进度');
    expect(shown.blocks).toEqual([{ kind: 'text', content: '第一阶段完成。', streaming: false }]);
  });
});

describe('the note under the answer', () => {
  const scheduled = done([{ kind: 'text', content: 'ANSWER', streaming: false }], {
    resume: { kind: 'scheduled', at: AT, ledger: '/tmp/l.md' },
  });

  it('says when the task goes on, in every reply mode', () => {
    const when = formatMoment(AT);
    expect(JSON.stringify(renderCard(scheduled))).toContain(`${when}** 自动继续`);
    expect(renderText(scheduled)).toContain(`${when}** 自动继续，按任务台账接着做`);
    expect(JSON.stringify(renderFinalCard(scheduled, { headerTemplate: 'violet' }))).toContain(`${when}** 自动继续`);
    // The note survives the cut to the final answer.
    expect(renderText(finalAnswerState(scheduled))).toContain('自动继续');
  });

  it('still says it when the marker was all the answer held', () => {
    const bare = done([], { resume: { kind: 'scheduled', at: AT } });
    const card = JSON.stringify(renderCard(bare));
    expect(card).toContain('自动继续');
    expect(card).not.toContain('未返回内容');
    expect(renderFinalCard(bare, { headerTemplate: 'violet' })).toBeDefined();
  });

  it('says why a marker was not honoured, and what was cancelled', () => {
    expect(resumeNotice({ kind: 'rejected', reason: 'not-owner' })).toContain('只有主人发起的任务');
    expect(resumeNotice({ kind: 'rejected', reason: 'too-far' })).toContain('24 小时');
    expect(resumeNotice({ kind: 'cancelled', at: AT })).toContain(`已取消原定 ${formatMoment(AT)}`);
    expect(resumeNotice({ kind: 'scheduled', at: AT, clamped: true })).toContain('5 分钟后');
    expect(resumeNotice({ kind: 'scheduled', at: AT }, 'en')).toContain('Will resume automatically');
  });
});

describe('the run instruction', () => {
  it('names the three markers and, when one is pending, its time', () => {
    const plain = scheduledResumeInstruction();
    expect(plain).toContain('[[RESUME_AFTER: five_hour');
    expect(plain).toContain('[[RESUME_AT:');
    expect(plain).toContain('[[RESUME_CANCEL]]');
    expect(plain).not.toContain('当前已约定');
    expect(scheduledResumeInstruction({ at: AT, ledger: '/tmp/l.md' })).toContain(`当前已约定 ${formatMoment(AT)} 自动继续（台账 /tmp/l.md）`);
  });
});
