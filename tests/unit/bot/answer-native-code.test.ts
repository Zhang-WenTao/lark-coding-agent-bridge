import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { answerMovedState, deliverCodeNatively, sendFinalReply } from '../../../src/bot/reply-delivery.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

const SQL = "SELECT * FROM t WHERE note = '$$ $&';";
const CODE_ANSWER = `查到了，执行：\n\n\`\`\`sql\n${SQL}\n\`\`\``;
const TABLE_ANSWER = `| 表 | 行数 |\n|---|---|\n| a | 1 |\n\n\`\`\`sql\n${SQL}\n\`\`\``;

/** Tool call, then an answer; finished cleanly unless told otherwise. */
function run(answer: string, end: AgentEvent = { type: 'done', terminationReason: 'normal' }): RunState {
  return stateFrom([
    { type: 'text', delta: '先查一下。' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    { type: 'text', delta: answer },
    end,
  ]);
}

function fakeChannel(fail = false): { channel: LarkChannel; sent: Array<{ content: Record<string, unknown>; opts: unknown }> } {
  const sent: Array<{ content: Record<string, unknown>; opts: unknown }> = [];
  const channel = {
    send: vi.fn(async (_chatId: string, content: Record<string, unknown>, opts: unknown) => {
      if (fail) throw new Error('send failed');
      sent.push({ content, opts });
      return { messageId: `om_${sent.length}` };
    }),
  } as unknown as LarkChannel;
  return { channel, sent };
}

/** The `md` text of a sent post. */
function postText(content: Record<string, unknown>): string {
  const post = content.post as { zh_cn: { content: Array<Array<{ text: string }>> } };
  return post.zh_cn.content[0]![0]!.text;
}

const base = { chatId: 'oc_x', scope: 'oc_x', sendOpts: { replyTo: 'om_q' }, locale: 'zh' as const };

describe('deliverCodeNatively', () => {
  it('posts an answer holding code, then points the card at it', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async (_state: RunState) => {});
    const state = run(CODE_ANSWER);

    await expect(deliverCodeNatively({ ...base, channel, state, updateCard })).resolves.toBe('answer');

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.content)).toEqual(['post']);
    expect(postText(sent[0]!.content)).toBe(CODE_ANSWER);
    expect(sent[0]!.opts).toEqual({ replyTo: 'om_q' });
    // The card keeps the process and loses only the answer.
    const card = updateCard.mock.calls[0]![0];
    expect(card.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(card.blocks[0]).toMatchObject({ content: '先查一下。' });
    expect(JSON.stringify(card.blocks[2])).toContain('答复见下一条消息');
    expect(JSON.stringify(card)).not.toContain('SELECT');
  });

  it('keeps an answer with a table on the card and posts only its code', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {});

    await expect(deliverCodeNatively({ ...base, channel, state: run(TABLE_ANSWER), updateCard })).resolves.toBe('code');

    expect(sent.map((s) => postText(s.content))).toEqual([`\`\`\`sql\n${SQL}\n\`\`\``]);
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('posts only the code when there is no card to point from', async () => {
    const { channel, sent } = fakeChannel();
    await expect(deliverCodeNatively({ ...base, channel, state: run(CODE_ANSWER) })).resolves.toBe('code');
    expect(sent.map((s) => postText(s.content))).toEqual([`\`\`\`sql\n${SQL}\n\`\`\``]);
  });

  it('sends nothing for an answer without code, or a run that did not finish cleanly', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {});
    await expect(deliverCodeNatively({ ...base, channel, state: run('没有代码'), updateCard })).resolves.toBe('none');
    const failed = run(CODE_ANSWER, { type: 'error', message: 'boom', terminationReason: 'failed' });
    await expect(deliverCodeNatively({ ...base, channel, state: failed, updateCard })).resolves.toBe('none');
    // Code in an earlier note is not the answer.
    const toolLast = stateFrom([
      { type: 'text', delta: CODE_ANSWER },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await expect(deliverCodeNatively({ ...base, channel, state: toolLast, updateCard })).resolves.toBe('none');
    expect(sent).toEqual([]);
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('leaves the card alone when the post cannot be sent', async () => {
    const { channel } = fakeChannel(true);
    const updateCard = vi.fn(async () => {});
    await expect(deliverCodeNatively({ ...base, channel, state: run(CODE_ANSWER), updateCard })).resolves.toBe('none');
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('still counts the answer as delivered when only the pointer update fails', async () => {
    const { channel, sent } = fakeChannel();
    const updateCard = vi.fn(async () => {
      throw new Error('patch failed');
    });
    await expect(deliverCodeNatively({ ...base, channel, state: run(CODE_ANSWER), updateCard })).resolves.toBe('answer');
    expect(sent).toHaveLength(1);
  });
});

describe('answerMovedState', () => {
  it('replaces every trailing answer block with one English pointer line', () => {
    const moved = answerMovedState(run(CODE_ANSWER), 'en');
    expect(moved.blocks.at(-1)).toMatchObject({ kind: 'text', streaming: false });
    expect(JSON.stringify(moved.blocks.at(-1))).toContain('next message');
  });
});

describe('sendFinalReply in card mode', () => {
  const finalState = (answer: string): RunState => ({
    ...initialState,
    blocks: [{ kind: 'text', content: answer, streaming: false }],
    finalText: answer,
    terminal: 'done',
  });
  const send = (channel: LarkChannel, state: RunState) =>
    sendFinalReply({
      channel,
      chatId: 'oc_x',
      scope: 'oc_x',
      state,
      replyMode: 'card',
      sendOpts: { replyTo: 'om_q' },
      cardRenderOptions: {},
    });

  it('sends an answer holding code as a post instead of a card', async () => {
    const { channel, sent } = fakeChannel();
    await send(channel, finalState(CODE_ANSWER));
    expect(sent.map((s) => Object.keys(s.content))).toEqual([['post']]);
    expect(postText(sent[0]!.content)).toBe(CODE_ANSWER);
  });

  it('sends a card, then the code, when the answer has a table', async () => {
    const { channel, sent } = fakeChannel();
    await send(channel, finalState(TABLE_ANSWER));
    expect(sent.map((s) => Object.keys(s.content)[0])).toEqual(['card', 'post']);
    expect(postText(sent[1]!.content)).toBe(`\`\`\`sql\n${SQL}\n\`\`\``);
    expect(sent[1]!.opts).toEqual({ replyTo: 'om_q' });
  });

  it('sends just the card for an answer without code', async () => {
    const { channel, sent } = fakeChannel();
    await send(channel, finalState('没有代码'));
    expect(sent.map((s) => Object.keys(s.content)[0])).toEqual(['card']);
  });
});
