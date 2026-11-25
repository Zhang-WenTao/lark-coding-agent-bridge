import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import {
  addDoneReaction,
  addQueuedReaction,
  addWorkingReaction,
  QueuedReactions,
  removeReaction,
} from '../../../src/bot/reaction';

function fakeChannel(overrides: Partial<LarkChannel> = {}): LarkChannel {
  return {
    addReaction: vi.fn(async () => 'reaction_1'),
    removeReaction: vi.fn(async () => {}),
    ...overrides,
  } as unknown as LarkChannel;
}

describe('addWorkingReaction', () => {
  it('adds a Typing reaction and returns its id', async () => {
    const channel = fakeChannel();
    const id = await addWorkingReaction(channel, 'om_1');
    expect(channel.addReaction).toHaveBeenCalledWith('om_1', 'Typing');
    expect(id).toBe('reaction_1');
  });

  it('swallows errors and returns undefined', async () => {
    const channel = fakeChannel({ addReaction: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(addWorkingReaction(channel, 'om_1')).resolves.toBeUndefined();
  });
});

describe('addDoneReaction', () => {
  it('adds a DONE reaction and returns its id', async () => {
    const channel = fakeChannel();
    const id = await addDoneReaction(channel, 'om_1');
    expect(channel.addReaction).toHaveBeenCalledWith('om_1', 'DONE');
    expect(id).toBe('reaction_1');
  });

  it('swallows errors and returns undefined', async () => {
    const channel = fakeChannel({ addReaction: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(addDoneReaction(channel, 'om_1')).resolves.toBeUndefined();
  });
});

describe('removeReaction', () => {
  it('delegates to channel.removeReaction', async () => {
    const channel = fakeChannel();
    await removeReaction(channel, 'om_1', 'reaction_1');
    expect(channel.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
  });

  it('swallows errors', async () => {
    const channel = fakeChannel({ removeReaction: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(removeReaction(channel, 'om_1', 'reaction_1')).resolves.toBeUndefined();
  });
});

describe('addQueuedReaction', () => {
  it('adds a OneSecond reaction and returns its id', async () => {
    const channel = fakeChannel();
    await expect(addQueuedReaction(channel, 'om_1')).resolves.toBe('reaction_1');
    expect(channel.addReaction).toHaveBeenCalledWith('om_1', 'OneSecond');
  });
});

describe('QueuedReactions', () => {
  it('marks a message once and takes the reaction off when released', async () => {
    const channel = fakeChannel();
    const queued = new QueuedReactions(channel);
    queued.mark('om_1');
    queued.mark('om_1');
    await queued.release(['om_1', 'om_other']);
    expect(channel.addReaction).toHaveBeenCalledTimes(1);
    expect(channel.removeReaction).toHaveBeenCalledTimes(1);
    expect(channel.removeReaction).toHaveBeenCalledWith('om_1', 'reaction_1');
    // Released already: a second release does nothing.
    await queued.release(['om_1']);
    expect(channel.removeReaction).toHaveBeenCalledTimes(1);
  });

  it('skips the removal when the reaction never landed', async () => {
    const channel = fakeChannel({ addReaction: vi.fn(async () => { throw new Error('boom'); }) });
    const queued = new QueuedReactions(channel);
    queued.mark('om_1');
    await queued.release(['om_1']);
    expect(channel.removeReaction).not.toHaveBeenCalled();
  });
});
