import { getDream } from '../../config/schema';
import {
  formatDreamPrs,
  formatDreamRevert,
  formatDreamRun,
  formatDreamStatus,
} from '../../dream/format';
import type { CommandContext } from '../types';
import { reply } from '../shared';

/**
 * `/practice` — 课堂精练. Admin-only and DM-only: a run reads every chat's
 * conversations, and its drafts and diffs can carry any of them. The chat only
 * ever sees counts and PR links; `diff` is the one view of draft content.
 */
export async function handleDream(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '课堂精练涉及所有会话的内容，请私聊 bot 发送 `/practice`。');
    return;
  }
  const dream = ctx.controls.dream;
  if (!dream) {
    await reply(ctx, '当前 bridge 没有启用课堂精练（缺少 profile 数据目录或知识库）。');
    return;
  }
  const [sub = '', ...rest] = args.trim().split(/\s+/);
  switch (sub) {
    case '':
    case 'status':
      await reply(ctx, formatDreamStatus(await dream.status()));
      return;
    case 'run': {
      const actor = { id: ctx.msg.senderId, ...(ctx.msg.senderName ? { name: ctx.msg.senderName } : {}) };
      const started = await dream.start(actor, (run) => {
        void reply(ctx, formatDreamRun(run));
      });
      await reply(
        ctx,
        'error' in started
          ? `❌ ${started.error}`
          : `📚 已开始整理，批次 \`${started.run.id}\`。${getDream(ctx.controls.cfg)?.external.length ? '先做课前学习，再' : ''}读取已结束的会话、生成草稿并${getDream(ctx.controls.cfg)?.publish === 'push' ? '直接提交推送（写更新日志）' : '开 Draft PR'}，完成后在这里回复结果；\`/practice cancel\` 可以取消。`,
      );
      return;
    }
    case 'cancel':
      await reply(ctx, dream.cancel() ? '⏹ 已请求取消，当前步骤结束后停止；游标不会移动。' : '现在没有在进行的整理。');
      return;
    case 'prs':
      await reply(ctx, formatDreamPrs(await dream.pullRequests()));
      return;
    case 'revert': {
      if (!rest[0]) {
        await reply(ctx, '用法：`/practice revert <批次>`，批次号见 `/practice prs`。');
        return;
      }
      const result = await dream.revert(rest[0]);
      await reply(ctx, 'error' in result ? `❌ ${result.error}` : formatDreamRevert(result));
      return;
    }
    case 'diary': {
      const result = dream.diary(rest[0]);
      await reply(ctx, 'error' in result ? result.error : `**🌙 梦境日记**\n\n${result.diary.replace(/^## /, '### ')}`);
      return;
    }
    case 'diff': {
      const result = await dream.diff(rest[0]);
      if ('error' in result) {
        await reply(ctx, result.error);
        return;
      }
      const fence = '```';
      const body = result.parts
        .map((part) => `**${part.label}**\n${fence}diff\n${clipDiff(part.diff, 6000).replaceAll(fence, "'''")}\n${fence}`)
        .join('\n\n');
      await reply(ctx, `**📚 批次 \`${result.id}\` 的差异**\n\n${body}`);
      return;
    }
    default:
      await reply(
        ctx,
        [
          '**📚 课堂精练**',
          '',
          '`/practice` — 状态：开关、目标仓库、上次结果、待审核 PR 数',
          '`/practice run` — 立即整理：先学配置的外部库（课前学习），再读取已结束的会话，生成记忆 / 笔记 / skill 草稿并发布',
          '`/practice cancel` — 取消正在进行的整理',
          '`/practice prs` — 整理开出的 PR 及审核状态',
          '`/practice diff [批次]` — 查看某个批次的差异（默认最近一次）',
          '`/practice diary [批次]` — 梦境日记：这一轮读了什么、归纳出什么主题、写进 / 整合 / 归档了什么、多少没采纳（默认最近一次）',
          '`/practice revert <批次>` — 撤销一个已合并的批次（开一个撤销用的 Draft PR）',
          '',
          '默认以 Draft PR 发布、审核合并后才生效；配置文件里 `dreamTuning.publish: "push"` 改为直接提交推送并写 CHANGELOG.md。「课堂精练」「自动整理」两个开关在 `/config` 里。',
          '自动整理默认不按天跑：新内容攒够、距上次够久、上一批 PR 审完、在允许时段且没有别的任务时才跑；设了 `dreamTuning.dailyAt` 就每天定时跑。用户消息一来就让路。',
        ].join('\n'),
      );
  }
}

function clipDiff(diff: string, max: number): string {
  return diff.length > max ? `${diff.slice(0, max)}\n… (已截断，完整内容见 PR)` : diff;
}
