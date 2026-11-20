import { describe, expect, it } from 'vitest';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { scopeFor, scopeKey } from '../../../src/bot/scope.js';
import { scopeKey as coreScopeKey } from '../../../src/core/scope-key.js';
import { kickoffScope } from '../../../src/bot/kickoff-inbox.js';

describe('scopeKey', () => {
  it('p2p chat (no thread): the chat id on its own', () => {
    expect(scopeKey('oc_p2p')).toBe('oc_p2p');
  });

  it('ordinary group (no thread): the chat id on its own', () => {
    expect(scopeKey('oc_group', undefined)).toBe('oc_group');
  });

  it('topic: chat id and thread id joined by a colon', () => {
    expect(scopeKey('oc_topic', 'omt_1')).toBe('oc_topic:omt_1');
  });

  it('an empty thread id counts as no thread', () => {
    expect(scopeKey('oc_group', '')).toBe('oc_group');
  });

  it('bot/scope re-exports the core implementation', () => {
    expect(scopeKey).toBe(coreScopeKey);
  });

  it('kickoffScope uses the same format', () => {
    expect(kickoffScope({ chatId: 'oc_a', threadId: 'omt_b' } as never)).toBe('oc_a:omt_b');
    expect(kickoffScope({ chatId: 'oc_a' } as never)).toBe('oc_a');
  });
});

describe('scopeFor', () => {
  const channelWithMode = (mode: 'p2p' | 'group' | 'topic') => ({
    getChatMode: async () => mode,
  });

  it('only topic chats with a thread get a thread-scoped key', async () => {
    for (const mode of ['p2p', 'group'] as const) {
      const cache = new ChatModeCache();
      await expect(scopeFor(channelWithMode(mode) as never, 'oc_x', 'omt_y', cache)).resolves.toBe('oc_x');
    }
    const cache = new ChatModeCache();
    await expect(scopeFor(channelWithMode('topic') as never, 'oc_x', 'omt_y', cache)).resolves.toBe('oc_x:omt_y');
    await expect(scopeFor(channelWithMode('topic') as never, 'oc_x', undefined, new ChatModeCache())).resolves.toBe('oc_x');
  });
});
