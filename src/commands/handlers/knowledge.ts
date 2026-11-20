import { knowledgeRepoStatus } from '../../knowledge/sync';
import { log } from '../../core/logger';
import type { CommandContext } from '../types';

/** Knowledge summary for the `/status` card; silent when the store is absent. */
export async function knowledgeStatusLine(ctx: CommandContext): Promise<{ knowledge?: string }> {
  const store = ctx.controls.knowledge;
  if (!store) return {};
  try {
    const [chat, profile, skills, repo] = await Promise.all([
      store.listMemories({ kind: 'chat', scopeId: ctx.scope }),
      store.listMemories({ kind: 'profile' }),
      store.listSkills(),
      knowledgeRepoStatus(store),
    ]);
    if (chat.length + profile.length + skills.length === 0 && !repo) return {};
    const sync = repo?.upstream
      ? `同步 ↑${repo.upstream.ahead} ↓${repo.upstream.behind}`
      : repo
        ? '未绑定远端'
        : '未启用同步';
    return {
      knowledge: `记忆 ${chat.length}(本会话)/${profile.length}(全局) · skills ${skills.length} · ${sync}`,
    };
  } catch (err) {
    log.warn('knowledge', 'status-line-failed', { err: String(err) });
    return {};
  }
}
