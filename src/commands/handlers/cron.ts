import { cronCard } from '../../card/templates';
import type { Scheduler } from '../../scheduler/scheduler';
import {
  CRON_USAGE,
  jobStatusLine,
  jobTitleMd,
  lastRunLine,
  normalizeJobName,
  parseAdd,
  scheduleSummary,
  scheduleSummaryPlain,
  truncate,
} from '../../scheduler/command';
import { jobScopeId } from '../../scheduler/runner';
import type { ScheduledJob } from '../../scheduler/types';
import { log } from '../../core/logger';
import { formatDateTime } from '../../core/time-format';
import type { CommandContext } from '../types';
import { commandReplyOptions, reply } from '../shared';
import { effectiveWorkspaceCwd } from './workspace';

export async function handleCron(args: string, ctx: CommandContext): Promise<void> {
  const scheduler = ctx.controls.scheduler;
  if (!scheduler) {
    await reply(ctx, '当前 bridge 没有启用定时任务（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);
  const restText = trimmed.slice(sub.length).trim();

  switch (sub) {
    case '':
    case 'list':
      return cronList(ctx, scheduler);
    case 'add':
      return cronAdd(restText, ctx, scheduler);
    case 'show':
      return cronShow(rest[0] ?? '', ctx, scheduler);
    case 'run':
      return cronRun(rest[0] ?? '', ctx, scheduler);
    case 'pause':
      return cronToggle(rest[0] ?? '', false, ctx, scheduler);
    case 'resume':
      return cronToggle(rest[0] ?? '', true, ctx, scheduler);
    case 'rename':
      return cronRename(rest[0] ?? '', restText.slice((rest[0] ?? '').length).trim(), ctx, scheduler);
    case 'remove':
    case 'rm':
      return cronRemove(rest[0] ?? '', ctx, scheduler);
    default:
      await reply(ctx, CRON_USAGE);
  }
}

/**
 * Jobs are managed only from the chat that owns them. Someone who can see a
 * job id in one chat must not be able to pause or delete another chat's job
 * from somewhere else.
 */
function cronJobInScope(
  id: string,
  ctx: CommandContext,
  scheduler: Scheduler,
): ScheduledJob | undefined {
  const job = scheduler.jobs.get(id.trim());
  if (!job || job.chatId !== ctx.msg.chatId) return undefined;
  return job;
}

async function cronList(ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const jobs = scheduler.jobs.listForChat(
    ctx.msg.chatId,
    ctx.chatMode === 'topic' ? ctx.msg.threadId : undefined,
  );
  const card = cronCard(
    jobs.map((job) => ({
      id: job.id,
      ...(job.name ? { name: job.name } : {}),
      schedule: scheduleSummaryPlain(job),
      status: jobStatusLine(job),
      ...(lastRunLine(job) ? { lastRun: lastRunLine(job)! } : {}),
      prompt: truncate(job.prompt, 120),
      enabled: job.enabled,
    })),
    '发送 `/cron add 0 9 * * 1-5 | 看一下昨天 CI 的失败并总结` 建一个。',
  );
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function cronAdd(args: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  if (!args) {
    await reply(ctx, CRON_USAGE);
    return;
  }
  const parsed = parseAdd(args);
  if (!parsed.ok) {
    await reply(ctx, `❌ ${parsed.error}\n\n${CRON_USAGE}`);
    return;
  }

  const cwd = effectiveWorkspaceCwd(ctx);
  const job = scheduler.jobs.add({
    ...(parsed.value.name ? { name: parsed.value.name } : {}),
    prompt: parsed.value.prompt,
    schedule: parsed.value.schedule,
    session: parsed.value.session,
    chatId: ctx.msg.chatId,
    chatType: ctx.chatMode,
    ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    anchorMessageId: ctx.msg.messageId,
    creatorId: ctx.msg.senderId,
    ...(cwd ? { cwd } : {}),
    enabled: true,
    createdAt: Date.now(),
  });
  const armed = scheduler.armJob(job.id) ?? job;
  log.info('scheduler', 'job-created', {
    jobId: job.id,
    kind: job.schedule.kind,
    scope: ctx.scope,
  });

  await reply(
    ctx,
    [
      `✅ 已创建定时任务 ${jobTitleMd(armed)}`,
      `- 计划：${scheduleSummary(armed)}`,
      `- 下次运行：${armed.nextRunAt ? formatDateTime(armed.nextRunAt) : '未排期'}`,
      `- 工作目录：\`${armed.cwd ?? '(profile 默认)'}\``,
      `- 会话：${armed.session === 'continue' ? '跨次复用' : '每次新建'}`,
      '',
      `\`/cron run ${armed.id}\` 可以立刻试跑一次。`,
    ].join('\n'),
  );
}

async function cronShow(id: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  const lines = [
    `**定时任务 ${jobTitleMd(job)}**`,
    `- 名称：${job.name ?? '（未命名，可用 \`/cron rename ' + job.id + ' <名称>\` 设置）'}`,
    `- 计划：${scheduleSummary(job)}`,
    `- 状态：${jobStatusLine(job)}`,
    `- 工作目录：\`${job.cwd ?? '(profile 默认)'}\``,
    `- 会话：${job.session === 'continue' ? '跨次复用' : '每次新建'}`,
    `- 创建于：${formatDateTime(job.createdAt)}`,
  ];
  const last = lastRunLine(job);
  if (last) lines.push(`- ${last}`);
  lines.push('', '任务内容：', job.prompt);
  await reply(ctx, lines.join('\n'));
}

async function cronRun(id: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  // The run posts its own result when it finishes; a test run of a real job
  // can take minutes, and blocking the command reply on it would look hung.
  await reply(ctx, `▶️ 已触发 ${jobTitleMd(job)}，结果会单独发出来。`);
  void scheduler.runNow(job.id).catch((err: unknown) => {
    log.fail('scheduler', err, { jobId: job.id, step: 'manual-run' });
  });
}

async function cronToggle(
  id: string,
  enabled: boolean,
  ctx: CommandContext,
  scheduler: Scheduler,
): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  // Resuming also clears the failure streak: the point of resuming is that
  // whatever kept failing was fixed.
  scheduler.jobs.update(job.id, { enabled, ...(enabled ? { failureStreak: 0 } : {}) });
  const armed = scheduler.armJob(job.id);
  // Pausing a job that is mid-run has to stop that run too — a scheduled run
  // owns its own scope, so the chat's `/stop` cannot reach it.
  const stopped = !enabled && ctx.activeRuns.interrupt(jobScopeId(job.id));
  await reply(
    ctx,
    enabled
      ? `▶️ 已恢复 ${jobTitleMd(job)}，下次运行：${armed?.nextRunAt ? formatDateTime(armed.nextRunAt) : '未排期'}`
      : `⏸ 已暂停 ${jobTitleMd(job)}${stopped ? '，并中断了正在执行的那次运行' : ''}。`,
  );
}

async function cronRemove(id: string, ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, '未找到该任务（只能管理当前会话创建的任务）。');
    return;
  }
  scheduler.jobs.remove(job.id);
  const stopped = ctx.activeRuns.interrupt(jobScopeId(job.id));
  log.info('scheduler', 'job-removed', { jobId: job.id, scope: ctx.scope, stoppedRun: stopped });
  await reply(ctx, `🗑 已删除 ${jobTitleMd(job)}${stopped ? '，并中断了正在执行的那次运行' : ''}。`);
}

async function cronRename(
  id: string,
  rawName: string,
  ctx: CommandContext,
  scheduler: Scheduler,
): Promise<void> {
  const job = cronJobInScope(id, ctx, scheduler);
  if (!job) {
    await reply(ctx, id ? '未找到该任务（只能管理当前会话创建的任务）。' : '用法：`/cron rename <id> <名称>`');
    return;
  }
  const parsed = normalizeJobName(rawName.replace(/^["“](.*)["”]$/, '$1'));
  if (!parsed.ok) {
    await reply(ctx, `❌ ${parsed.error}`);
    return;
  }
  // An undefined name is dropped when the store serialises, which clears it.
  scheduler.jobs.update(job.id, { name: parsed.value });
  log.info('scheduler', 'job-renamed', { jobId: job.id, scope: ctx.scope });
  await reply(
    ctx,
    parsed.value ? `✏️ 已把 \`${job.id}\` 命名为「${parsed.value}」。` : `✏️ 已清除 \`${job.id}\` 的名称。`,
  );
}

// ─── /account ─────────────────────────────────────────────────────────────
