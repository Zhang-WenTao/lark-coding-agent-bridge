import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json';
import type { AgentEvent } from '../../../src/agent/types';
import { pauseNotice } from '../../../src/card/pause-notice';
import {
  finalAnswerState,
  initialState,
  NO_REPLY_MARKER,
  reduce,
  stripControlMarkers,
  type RunState,
} from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

const run = (events: AgentEvent[]): RunState => events.reduce(reduce, initialState);
const tool = (id: string): AgentEvent[] => [
  { type: 'tool_use', id, name: 'Bash', input: { command: 'git status' } },
  { type: 'tool_result', id, output: 'ok', isError: false },
];
const done: AgentEvent = { type: 'done', terminationReason: 'normal' };

describe('finalAnswerState', () => {
  it('cuts a real Claude turn to what `claude -p` reports as its result', () => {
    // Real capture: Claude narrates before each tool call and never sends a
    // final text; its `result` event carries only the text after the last call.
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/claude-narrated-turn.json'), 'utf8'),
    ) as { events: Array<{ type: string; result?: string }> };
    const result = fixture.events.find((e) => e.type === 'result')?.result;
    const state = run([...fixture.events.flatMap((e) => [...translateEvent(e)]), done]);

    expect(state.finalText).toBeUndefined();
    expect(renderText(state)).toContain('我要依次运行两次 echo 命令');
    expect(renderText(finalAnswerState(state))).toBe(result);
  });

  it('keeps the text after the last tool call, not the notes between tool calls', () => {
    const state = run([
      { type: 'text', delta: '我先看一下日志。' },
      ...tool('t1'),
      { type: 'text', delta: '再确认一下配置。' },
      ...tool('t2'),
      { type: 'text', delta: '结论：配置没问题。' },
      done,
    ]);
    const text = renderText(finalAnswerState(state));
    expect(text).toBe('结论：配置没问题。');
  });

  it('keeps all the text of a run without tool calls', () => {
    const state = run([{ type: 'text', delta: '直接回答' }, done]);
    expect(renderText(finalAnswerState(state))).toBe('直接回答');
  });

  it('prefers the final text the agent reported', () => {
    const state = run([
      { type: 'text', delta: 'progress note' },
      ...tool('t1'),
      { type: 'final_text', content: 'the answer' },
      done,
    ]);
    expect(renderText(finalAnswerState(state))).toBe('the answer');
  });

  it('keeps what a run stopped in the middle of a tool call said, with the notice', () => {
    const state = run([
      { type: 'text', delta: '先跑一下测试。' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'done', terminationReason: 'interrupted' },
    ]);
    const text = renderText(finalAnswerState(state));
    expect(text).toContain('先跑一下测试');
    expect(text).toContain('中断');
    expect(text).not.toContain('pnpm test');
  });

  it('keeps the error and pause notices', () => {
    const failed = run([...tool('t1'), { type: 'error', message: 'boom', terminationReason: 'failed' }]);
    expect(renderText(finalAnswerState(failed))).toContain('boom');

    const paused = run([
      { type: 'text', delta: '查一下。' },
      ...tool('t1'),
      { type: 'rate_limit', blocked: true, limitType: 'five_hour', at: 1 },
      done,
    ]);
    expect(paused.terminal).toBe('paused');
    expect(renderText(finalAnswerState(paused))).toContain(pauseNotice(paused.limit));
  });

  it('keeps an answer written before a wrap-up tool call that ends on a short sign-off', () => {
    const answer = `结论：${'配置没问题，'.repeat(40)}可以上线。`;
    const state = run([
      { type: 'text', delta: '我先看一下日志。' },
      ...tool('t1'),
      { type: 'text', delta: answer },
      ...tool('t2'),
      { type: 'text', delta: '已保存。' },
      done,
    ]);
    const text = renderText(finalAnswerState(state));
    expect(text).toContain(answer);
    expect(text).toContain('已保存。');
    expect(text).not.toContain('我先看一下日志');
  });

  it('does not pull short notes back in front of a short answer', () => {
    const state = run([
      { type: 'text', delta: '我先看一下日志。' },
      ...tool('t1'),
      { type: 'text', delta: '没问题。' },
      done,
    ]);
    expect(renderText(finalAnswerState(state))).toBe('没问题。');
  });

  it('keeps a [[NO_REPLY]] tail even after a long earlier answer', () => {
    const state = run([
      { type: 'text', delta: '说明'.repeat(200) },
      ...tool('t1'),
      { type: 'text', delta: NO_REPLY_MARKER },
      done,
    ]);
    expect(renderText(stripControlMarkers(finalAnswerState(state))).trim()).toBe('');
  });

  it('leaves nothing to send when the answer after the tool calls is [[NO_REPLY]]', () => {
    const state = run([
      { type: 'text', delta: '我来发状态卡片。' },
      ...tool('t1'),
      { type: 'text', delta: NO_REPLY_MARKER },
      done,
    ]);
    expect(renderText(stripControlMarkers(finalAnswerState(state))).trim()).toBe('');
  });
});
