import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { registerChannelEvents, type ChannelEventSinks } from '../../../src/bot/channel-events';
import { EDIT_EVENT } from '../../../src/bot/edit';
import { RECALL_EVENT } from '../../../src/bot/recall';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (arg?: any) => any;
interface Handlers {
  message: Fn;
  cardAction: Fn;
  comment: Fn;
  reconnecting: Fn;
  reconnected: Fn;
}

function fakeChannel(withRaw = true) {
  let handlers = {} as Handlers;
  const raw = new Map<string, Fn>();
  const channel = {
    on: (h: Handlers) => {
      handlers = h;
    },
    ...(withRaw ? { onRawEvent: (name: string, fn: Fn) => void raw.set(name, fn) } : {}),
  } as unknown as LarkChannel;
  return { channel, handlers: () => handlers, raw };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function sinks(): ChannelEventSinks {
  return {
    message: vi.fn(async () => {}),
    cardAction: vi.fn(async () => {}),
    comment: vi.fn(async () => {}),
    recall: vi.fn(() => ({ action: 'none' })),
    edit: vi.fn(async () => {}),
  };
}

describe('registerChannelEvents', () => {
  it('hands messages, card actions and comments to the sinks, and never throws', async () => {
    const f = fakeChannel();
    const s = sinks();
    (s.message as any).mockRejectedValueOnce(new Error('boom'));
    registerChannelEvents(f.channel, s);
    await expect(f.handlers().message({ chatId: 'oc', messageId: 'om' })).resolves.toBeUndefined();
    await f.handlers().cardAction({ chatId: 'oc', messageId: 'om' });
    await f.handlers().comment({});
    expect(s.message).toHaveBeenCalledTimes(1);
    expect(s.cardAction).toHaveBeenCalledTimes(1);
    expect(s.comment).toHaveBeenCalledTimes(1);
  });

  it('escalates on the 3rd and 10th reconnect in a row and resets on reconnected', () => {
    const f = fakeChannel();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerChannelEvents(f.channel, sinks());
    for (let i = 0; i < 3; i++) f.handlers().reconnecting(undefined);
    expect(err).toHaveBeenCalledTimes(1);
    f.handlers().reconnected(undefined);
    for (let i = 0; i < 3; i++) f.handlers().reconnecting(undefined);
    expect(err).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('routes parsed recall and edit raw events; ignores unparsable ones', async () => {
    const f = fakeChannel();
    const s = sinks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerChannelEvents(f.channel, s);
    expect([...f.raw.keys()].sort()).toEqual([EDIT_EVENT, RECALL_EVENT].sort());
    f.raw.get(RECALL_EVENT)!({});
    await f.raw.get(EDIT_EVENT)!({});
    expect(s.recall).not.toHaveBeenCalled();
    expect(s.edit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('skips the raw events when the channel has no onRawEvent', () => {
    const f = fakeChannel(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => registerChannelEvents(f.channel, sinks())).not.toThrow();
    expect(f.raw.size).toBe(0);
    vi.restoreAllMocks();
  });
});
