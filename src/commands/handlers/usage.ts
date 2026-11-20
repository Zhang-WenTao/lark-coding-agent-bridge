import { agentAccountsReport, agentAccountsTable, switchAgentAccount } from '../../agent/account';
import { agentDescriptor } from '../../agent/registry';
import {
  emptyTotals,
  formatTokens,
  type UsageReportRow,
  type UsageTotals,
} from '../../runtime/usage-ledger';
import { helpCard, usageCard } from '../../card/templates';
import { parseClaudeUsage, readClaudeUsage, usageMarkdown } from '../usage';
import { canRunAdminCommand } from '../../policy/access';
import { log } from '../../core/logger';
import type { CommandContext } from '../types';
import { commandReplyOptions, reply, commandProfilePaths } from '../shared';

export async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent.displayName);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /usage ───────────────────────────────────────────────────────────────

/**
 * Plan quota, answered by the bridge itself through `claude -p /usage`: no
 * agent run, so it costs no quota and still answers while a run is busy or
 * stuck.
 */
export async function handleUsage(args: string, ctx: CommandContext): Promise<void> {
  const key = args.trim().toLowerCase();
  // `/usage` keeps answering the plan quota; a period asks for the
  // per-person consumption ledger instead.
  if (key && key !== 'quota') return handleUsageLedger(key, ctx);
  return handlePlanQuota(ctx);
}

async function handlePlanQuota(ctx: CommandContext): Promise<void> {
  // The plan quota of whoever runs the bridge, not something to show anyone
  // else; their own consumption is open to all (`/usage today`).
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '订阅额度仅管理员可看。看自己的用量请发 `/usage today`（或 week / month）。');
    return;
  }
  if (!agentDescriptor(ctx.controls.profileConfig.agentKind).planQuota) {
    await reply(ctx, '`/usage` 目前只支持 Claude profile。');
    return;
  }
  let raw: string;
  try {
    raw = await readClaudeUsage();
  } catch (err) {
    log.fail('command', err, { cmd: '/usage' });
    await reply(ctx, `❌ 读取额度失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const accounts = await agentAccountsReport(
    ctx.controls.profileConfig,
    commandProfilePaths(ctx).profileDir,
    accountNameView(ctx),
  );
  const body = usageMarkdown(parseClaudeUsage(raw), raw);
  const card = usageCard(
    accounts ? [`**CLI 登录账户**`, body, '', ...accounts, '_各账户用量取自它最近一次运行的报告。_'].join('\n') : body,
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

// ─── /accounts ────────────────────────────────────────────────────────────

/**
 * Accounts go by the owner's private names only in the owner's own DM: the
 * owner asked for them to stay out of every chat others can read (2026-11-06).
 */
function accountNameView(ctx: CommandContext): { private: boolean } {
  return {
    private: ctx.msg.chatType === 'p2p' && Boolean(ctx.controls.botOwnerId) && ctx.msg.senderId === ctx.controls.botOwnerId,
  };
}

/**
 * The profile's Claude subscription accounts: `/accounts` lists them as a
 * table (usage, resets, switch lines); `/accounts switch [name]` makes one the
 * main account — the best-scoring one with room when no name is given.
 */
export async function handleAccounts(args: string, ctx: CommandContext): Promise<void> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const profileDir = commandProfilePaths(ctx).profileDir;
  try {
    if (sub === '' || sub === 'list') {
      const table = await agentAccountsTable(ctx.controls.profileConfig, profileDir, accountNameView(ctx));
      await reply(ctx, table ?? '`/accounts` 目前只支持 Claude profile。');
      return;
    }
    if (sub === 'switch' || sub === '切换') {
      await reply(
        ctx,
        await switchAgentAccount(ctx.controls.profileConfig, profileDir, rest.join(' '), accountNameView(ctx)),
      );
      return;
    }
  } catch (err) {
    log.fail('command', err, { cmd: '/accounts', sub });
    await reply(ctx, `❌ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await reply(ctx, '用法：`/accounts` 查看账户；`/accounts switch` 自动切到得分最高的可用账户；`/accounts switch <名字或 id>` 切到指定账户（它要在切换线以下，否则不切）；`/accounts switch <名字或 id> <百分比>` 同时把它的切换线临时调到该值，到该窗口重置或自动切走后恢复原线。');
}

// ─── /coffee ──────────────────────────────────────────────────────────────

const USAGE_PERIODS: Record<string, { days: number; label: string }> = {
  today: { days: 1, label: '今天' },
  week: { days: 7, label: '近 7 天' },
  month: { days: 30, label: '近 30 天' },
};

/**
 * `/usage today|week|month`: whose runs consumed how much of the owner's
 * agent quota. Everyone sees their own numbers; only an admin in a private
 * chat sees everyone's, so one chat never learns another person's usage.
 */
async function handleUsageLedger(args: string, ctx: CommandContext): Promise<void> {
  const ledger = ctx.controls.usage;
  if (!ledger) {
    await reply(ctx, '当前 profile 没有开启用量统计。');
    return;
  }
  const key = args.trim().toLowerCase();
  if (key && !USAGE_PERIODS[key]) {
    await reply(ctx, '用法：`/usage` 看订阅额度；`/usage today|week|month` 看各人用量。');
    return;
  }
  const periods = key ? [USAGE_PERIODS[key]!] : [USAGE_PERIODS.today!, USAGE_PERIODS.week!];
  const everyone =
    ctx.chatMode === 'p2p' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
  const sections = periods.map((period) => {
    const rows = ledger.report({ days: period.days, ...(everyone ? {} : { actorId: ctx.msg.senderId }) });
    return formatUsageSection(period.label, rows, { everyone, selfId: ctx.msg.senderId });
  });
  const notes = [
    '_费用是按 API 价格估算的；订阅账号不实际扣费，只用来比较各人占用额度的多少。Codex 不报费用，只看 token。_',
    ...(ctx.chatMode !== 'p2p' && !everyone ? ['_只显示你自己的用量；管理员私聊发 `/usage` 可看所有人。_'] : []),
  ];
  await reply(ctx, [...sections, ...notes].join('\n\n'));
}

function formatUsageSection(
  label: string,
  rows: UsageReportRow[],
  opts: { everyone: boolean; selfId: string },
): string {
  if (rows.length === 0) return `**${label}**\n暂无用量记录。`;
  const total = rows.reduce((acc, row) => {
    acc.turns += row.total.turns;
    acc.inputTokens += row.total.inputTokens;
    acc.cachedInputTokens += row.total.cachedInputTokens;
    acc.outputTokens += row.total.outputTokens;
    acc.costUsd += row.total.costUsd;
    return acc;
  }, emptyTotals());
  if (!opts.everyone) return `**${label}**\n你：${formatUsageTotals(total)}`;
  const shown = rows.slice(0, 10).map((row, i) => {
    const who = row.actorId === opts.selfId ? '你' : (row.actorName ?? `…${row.actorId.slice(-6)}`);
    return `${i + 1}. ${who}：${formatUsageTotals(row.total)}`;
  });
  const more = rows.length > 10 ? [`…另有 ${rows.length - 10} 人`] : [];
  return [`**${label}**（${rows.length} 人）`, `合计：${formatUsageTotals(total)}`, ...shown, ...more].join('\n');
}

function formatUsageTotals(t: UsageTotals): string {
  const cached = t.cachedInputTokens > 0 ? `（缓存 ${formatTokens(t.cachedInputTokens)}）` : '';
  const cost = t.costUsd > 0 ? ` · 估算 $${t.costUsd.toFixed(2)}` : '';
  return `${t.turns} 轮 · 输入 ${formatTokens(t.inputTokens)}${cached} · 输出 ${formatTokens(t.outputTokens)}${cost}`;
}

/**
 * `approval.allow|allowturn|deny <id>` from an approval card. Allowing needs
 * an admin; the requester may cancel (deny) their own pending step. A click
 * that changes something gets no reply — the cards themselves update.
 */
export async function handleApproval(args: string, ctx: CommandContext): Promise<void> {
  const [verb, id] = args.trim().split(/\s+/);
  const action = verb === 'allow' ? 'allow' : verb === 'allowturn' ? 'allow-turn' : verb === 'deny' ? 'deny' : undefined;
  const broker = ctx.controls.approvals;
  if (!broker || !action || !id) return;
  const isAdmin = canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
  const result = broker.decide(id, ctx.msg.senderId, action, isAdmin);
  log.info('command', 'approval', { action, result, operator: ctx.msg.senderId.slice(-6) });
  if (result === 'forbidden') {
    await reply(ctx, action === 'deny' ? '只有发起人或管理员可以取消这一步。' : '只有管理员可以允许这一步。');
  } else if (result === 'not-found') {
    await reply(ctx, '这条审批已经处理过或已过期。');
  }
}
