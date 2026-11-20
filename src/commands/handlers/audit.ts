import { toolLabel } from '../../card/approval-cards';
import { formatMonthDayTime } from '../../core/time-format';
import type { CommandContext } from '../types';
import { reply } from '../shared';

const AUDIT_EVENT_LABELS: Record<string, string> = {
  allowed: '已允许',
  'auto-allowed': '本轮已允许',
  'config-allowed': '免审批清单',
  denied: '已拒绝',
  timeout: '超时拒绝',
  cancelled: '已取消',
};

/**
 * `/audit [N]`: the latest side-effecting steps (commands, file writes,
 * external tools) and approval decisions, newest first. Private chat only —
 * it spans every chat of the profile.
 */
export async function handleAudit(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '审计记录涉及所有会话，请私聊 bot 发送 `/audit` 查看。');
    return;
  }
  const audit = ctx.controls.audit;
  if (!audit) {
    await reply(ctx, '当前 profile 没有开启审计记录。');
    return;
  }
  const n = Number.parseInt(args.trim(), 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
  const entries = (await audit.query({ limit: limit * 3 }))
    .filter((e) => e.kind === 'tool' || (e.event && e.event in AUDIT_EVENT_LABELS))
    .slice(0, limit);
  if (entries.length === 0) {
    await reply(ctx, '还没有审计记录。');
    return;
  }
  const chats = new Map((ctx.controls.knownChats ?? []).map((c) => [c.id, c.name]));
  const lines = entries.map((e) => {
    const when = formatMonthDayTime(e.at);
    const who = e.actorId === ctx.msg.senderId ? '你' : (e.actorName ?? `…${e.actorId.slice(-6)}`);
    const where = e.chatId ? (chats.get(e.chatId) ?? '会话') : e.source;
    const what = `${toolLabel(e.tool)} \`${e.summary.replace(/`/g, "'").slice(0, 80)}\``;
    const outcome =
      e.kind === 'approval'
        ? ` · ${AUDIT_EVENT_LABELS[e.event!]}`
        : e.gated
          ? ' · 非管理员会话'
          : '';
    return `- ${when} ${who}（${where}）${what}${outcome}`;
  });
  await reply(ctx, [`**最近 ${entries.length} 条操作记录**`, ...lines].join('\n'));
}
