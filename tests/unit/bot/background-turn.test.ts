import { describe, expect, it } from 'vitest';
import { backgroundTurnState } from '../../../src/bot/channel';
import { stripNoReply, type RunState } from '../../../src/card/run-state';
import { renderText } from '../../../src/card/text-renderer';

const keepAll = (state: RunState): RunState => stripNoReply(state);
const done = { type: 'done', terminationReason: 'normal' } as const;

describe('background turn replies', () => {
  it('prefixes a background answer so it reads as a follow-up', () => {
    const state = backgroundTurnState({ kind: 'turn', events: [{ type: 'text', delta: 'build ok' }, done], background: 0 }, keepAll);
    const text = renderText(state!);
    expect(text).toContain('后台任务');
    expect(text).toContain('build ok');
  });

  it('stays silent for a turn with only tool calls or a no-reply marker', () => {
    expect(
      backgroundTurnState(
        {
          kind: 'turn',
          events: [
            { type: 'tool_use', id: 't', name: 'Read', input: {} },
            { type: 'tool_result', id: 't', output: 'x', isError: false },
            done,
          ],
          background: 0,
        },
        (state) => ({ ...keepAll(state), blocks: state.blocks.filter((b) => b.kind !== 'tool') }),
      ),
    ).toBeUndefined();
    expect(
      backgroundTurnState({ kind: 'turn', events: [{ type: 'text', delta: '[[NO_REPLY]]' }, done], background: 0 }, keepAll),
    ).toBeUndefined();
  });

  it('names the account the stopped process ran on, not the CLI login', () => {
    const state = backgroundTurnState(
      { kind: 'stopped', reason: 'shutdown', account: 'shilong.wang' },
      keepAll,
    );
    expect(state?.sponsor).toBe('shilong.wang');
    const turn = backgroundTurnState(
      { kind: 'turn', events: [{ type: 'account', label: 'shilong.wang' }, { type: 'text', delta: 'ok' }, done], background: 0 },
      keepAll,
    );
    expect(turn?.sponsor).toBe('shilong.wang');
  });

  it('says the work goes on when the follow-up leaves background tasks running', () => {
    const state = backgroundTurnState(
      { kind: 'turn', events: [{ type: 'text', delta: 'half done' }, done], background: 2 },
      keepAll,
    );
    expect(renderText(state!)).toContain('还有 2 个后台任务在跑');
  });

  it('stays silent for a heartbeat turn that only leaves background tasks running', () => {
    expect(
      backgroundTurnState({ kind: 'turn', events: [{ type: 'background', count: 1 }, done], background: 1 }, keepAll),
    ).toBeUndefined();
  });

  it('keeps just the answer a turn ends on when the reply is final-answer-only', () => {
    const events = [
      { type: 'text', delta: '看一下构建结果。' },
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'tail build.log' } },
      { type: 'tool_result', id: 't', output: 'ok', isError: false },
      { type: 'text', delta: '构建通过了。' },
      done,
    ] as const;
    const text = renderText(
      backgroundTurnState({ kind: 'turn', events: [...events], background: 0 }, keepAll, { finalAnswerOnly: true })!,
    );
    expect(text).toContain('后台任务');
    expect(text).toContain('构建通过了');
    expect(text).not.toContain('看一下构建结果');
    expect(text).not.toContain('tail build.log');

    // The full record, as before, when the option is off.
    const full = renderText(backgroundTurnState({ kind: 'turn', events: [...events], background: 0 }, keepAll)!);
    expect(full).toContain('看一下构建结果');

    // A [[NO_REPLY]] answer after tool calls still means no reply.
    expect(
      backgroundTurnState(
        { kind: 'turn', events: [...events.slice(0, 3), { type: 'text', delta: '[[NO_REPLY]]' }, done], background: 0 },
        keepAll,
        { finalAnswerOnly: true },
      ),
    ).toBeUndefined();
  });

  it('always reports background work that was stopped at the cap', () => {
    const state = backgroundTurnState({ kind: 'stopped', reason: 'max-linger', afterMs: 30 * 60_000 }, keepAll);
    expect(renderText(state!)).toContain('30 分钟');
  });
});
