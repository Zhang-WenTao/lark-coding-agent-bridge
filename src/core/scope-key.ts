/**
 * The session scope key for a conversation: `chatId` on its own, or
 * `${chatId}:${threadId}` when the conversation is a topic (thread).
 *
 * The single place that spells the format out. It lives in `core/` (not
 * `bot/scope.ts`, which re-exports it) so lower layers such as `scheduler/`
 * can use it without an upward import. An empty `threadId` counts as none,
 * matching the `threadId ? … : chatId` checks it replaced.
 */
export function scopeKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}
