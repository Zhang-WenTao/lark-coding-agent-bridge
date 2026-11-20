import { describeRepoStatus, readRepoStatus, type GitRepoStatus } from '../../git/status';
import { basename } from 'node:path';
import { diffCard, pullRequestCard, worktreeCard } from '../../card/templates';
import {
  describeDiffTarget,
  parseDiffTarget,
  previewPatch,
  readDiffPatch,
  readDiffStat,
} from '../../git/diff';
import { isGitError } from '../../git/exec';
import { checksLabel, parsePrArg, readPullRequest, reviewLabel } from '../../git/pr';
import { addWorktree, listWorktrees, matchWorktree, removeWorktree } from '../../git/worktree';
import { log } from '../../core/logger';
import { resolveWorkingDirectory } from '../../policy/workspace';
import type { CommandContext } from '../types';
import { commandReplyOptions, reply } from '../shared';
import { effectiveWorkspaceCwd } from './workspace';

/**
 * Git summary for the `/status` card. Silent when the cwd is not a repository
 * (or git is missing) — `/status` must stay useful for non-code workspaces.
 */
export async function gitStatusLine(cwd: string | undefined): Promise<{ git?: string }> {
  if (!cwd) return {};
  const status = await readRepoStatus(cwd).catch(() => undefined);
  return status ? { git: describeRepoStatus(status) } : {};
}

/** Resolve the repo the current session points at, or reply why we cannot. */
async function requireRepo(
  ctx: CommandContext,
): Promise<{ cwd: string; status: GitRepoStatus } | undefined> {
  const cwd = effectiveWorkspaceCwd(ctx);
  if (!cwd) {
    await reply(ctx, '当前会话没有工作目录，先用 `/cd <路径>` 指一个。');
    return undefined;
  }
  const status = await readRepoStatus(cwd).catch(() => undefined);
  if (!status) {
    await reply(ctx, `\`${cwd}\` 不是 git 仓库（或本机没有装 git）。`);
    return undefined;
  }
  return { cwd, status };
}

export async function handleDiff(args: string, ctx: CommandContext): Promise<void> {
  const repo = await requireRepo(ctx);
  if (!repo) return;

  const target = parseDiffTarget(args);
  if (isGitError(target)) {
    await reply(ctx, `❌ ${target.error}`);
    return;
  }

  const summary = await readDiffStat(repo.cwd, target);
  if (isGitError(summary)) {
    await reply(ctx, `❌ ${summary.error}`);
    return;
  }

  const patch = await readDiffPatch(repo.cwd, target);
  const patchText = isGitError(patch) ? '' : patch.patch;
  const preview = previewPatch(patchText);
  // Anything that did not fit inline goes out as a real .patch file — reading a
  // long diff as chat text is hopeless, and the file can be opened elsewhere.
  const attach = preview.omittedLines > 0 && patchText.length > 0;

  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: diffCard({
        scope: describeDiffTarget(target),
        files: summary.files,
        added: summary.added,
        removed: summary.removed,
        untracked: summary.untracked,
        preview: preview.text,
        omittedLines: preview.omittedLines,
        attached: attach,
      }),
    },
    commandReplyOptions(ctx),
  );

  if (!attach) return;
  const name = `${basename(repo.status.root)}-${target.kind === 'ref' ? target.ref.replace(/[^\w.-]+/g, '-') : target.kind}.patch`;
  await ctx.channel
    .send(
      ctx.msg.chatId,
      { file: { source: Buffer.from(patchText, 'utf8'), fileName: name } },
      commandReplyOptions(ctx),
    )
    .catch(async (err: unknown) => {
      log.warn('git', 'patch-upload-failed', { err: String(err) });
      await reply(ctx, '完整 patch 发送失败，可以在本地用 `git diff` 查看。');
    });
}

export async function handleWorktree(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);
  switch (sub) {
    case '':
    case 'list':
      return worktreeList(ctx);
    case 'add':
      return worktreeAdd(rest[0] ?? '', rest[1], ctx);
    case 'use':
      return worktreeUse(rest.join(' '), ctx);
    case 'remove':
    case 'rm':
      return worktreeRemove(rest.filter((token) => token !== '--force').join(' '), rest.includes('--force'), ctx);
    default:
      await reply(
        ctx,
        [
          '**worktree**',
          '',
          '`/worktree` — 列出当前仓库的 worktree',
          '`/worktree add <分支> [起点]` — 新建 worktree 并把本会话切过去',
          '`/worktree use <分支|路径>` — 切到已有的 worktree',
          '`/worktree remove <分支|路径> [--force]` — 删除',
        ].join('\n'),
      );
  }
}

async function worktreeList(ctx: CommandContext): Promise<void> {
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const entries = await listWorktrees(repo.cwd);
  if (isGitError(entries)) {
    await reply(ctx, `❌ ${entries.error}`);
    return;
  }
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: worktreeCard(
        entries.map((entry) => ({
          path: entry.path,
          ...(entry.branch ? { branch: entry.branch } : {}),
          ...(entry.head ? { head: entry.head } : {}),
          main: entry.main,
          current: entry.path === repo.status.root,
        })),
      ),
    },
    commandReplyOptions(ctx),
  );
}

async function worktreeAdd(branch: string, base: string | undefined, ctx: CommandContext): Promise<void> {
  if (!branch) {
    await reply(ctx, '用法：`/worktree add <分支> [起点]`');
    return;
  }
  const repo = await requireRepo(ctx);
  if (!repo) return;

  const created = await addWorktree({
    cwd: repo.cwd,
    repoRoot: repo.status.root,
    branch,
    ...(base ? { base } : {}),
  });
  if (isGitError(created)) {
    await reply(ctx, `❌ 新建 worktree 失败：${created.error}`);
    return;
  }

  ctx.workspaces.trackWorktree({
    repoRoot: repo.status.root,
    path: created.path,
    branch: created.branch,
    ownedBranch: !created.existingBranch,
  });

  // Creating a worktree for a task and then working in the old directory is
  // never what anyone means, so the session moves with it — same as `/cd`.
  const resolved = await resolveWorkingDirectory(created.path);
  if (!resolved.ok) {
    await reply(ctx, `worktree 已创建在 \`${created.path}\`，但切换失败：${resolved.userVisible}`);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, resolved.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  log.info('git', 'worktree-added', { scope: ctx.scope, branch: created.branch });
  await reply(
    ctx,
    [
      `🌿 已创建 worktree 并切过去：`,
      `- 分支：\`${created.branch}\`${created.existingBranch ? '（已存在的分支）' : '（新建分支）'}`,
      `- 路径：\`${resolved.cwdRealpath}\``,
      '',
      '会话已重置，接下来的对话都在这个 worktree 里。',
    ].join('\n'),
  );
}

async function worktreeUse(needle: string, ctx: CommandContext): Promise<void> {
  if (!needle) {
    await reply(ctx, '用法：`/worktree use <分支|路径>`');
    return;
  }
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const entries = await listWorktrees(repo.cwd);
  if (isGitError(entries)) {
    await reply(ctx, `❌ ${entries.error}`);
    return;
  }
  const match = matchWorktree(entries, needle);
  if (!match) {
    await reply(ctx, `没找到叫 \`${needle}\` 的 worktree，用 \`/worktree\` 看看列表。`);
    return;
  }
  const resolved = await resolveWorkingDirectory(match.path);
  if (!resolved.ok) {
    await reply(ctx, resolved.userVisible);
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.workspaces.setCwd(ctx.scope, resolved.cwdRealpath);
  ctx.sessions.clear(ctx.scope);
  await reply(ctx, `✓ 已切到 \`${resolved.cwdRealpath}\`（分支 \`${match.branch ?? '游离'}\`），会话已重置。`);
}

async function worktreeRemove(needle: string, force: boolean, ctx: CommandContext): Promise<void> {
  if (!needle) {
    await reply(ctx, '用法：`/worktree remove <分支|路径> [--force]`');
    return;
  }
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const entries = await listWorktrees(repo.cwd);
  if (isGitError(entries)) {
    await reply(ctx, `❌ ${entries.error}`);
    return;
  }
  const match = matchWorktree(entries, needle);
  if (!match) {
    await reply(ctx, `没找到叫 \`${needle}\` 的 worktree。`);
    return;
  }
  if (match.main) {
    await reply(ctx, '这是主 checkout，不能删。');
    return;
  }
  // Removing the tree the session is standing in would leave every later run
  // pointing at a path that no longer exists.
  if (match.path === repo.status.root) {
    await reply(ctx, '当前会话正在这个 worktree 里，先 `/worktree use <别的>` 或 `/cd` 出去再删。');
    return;
  }
  const removed = await removeWorktree(repo.cwd, match.path, { force });
  if (isGitError(removed)) {
    await reply(ctx, `❌ 删除失败：${removed.error}${force ? '' : '\n有未提交改动时可以加 `--force`。'}`);
    return;
  }
  ctx.workspaces.forgetWorktree(match.path);
  log.info('git', 'worktree-removed', { scope: ctx.scope, path: match.path });
  await reply(ctx, `🗑 已删除 worktree \`${match.path}\`。`);
}

export async function handlePr(args: string, ctx: CommandContext): Promise<void> {
  const repo = await requireRepo(ctx);
  if (!repo) return;
  const lookup = parsePrArg(args);
  if (isGitError(lookup)) {
    await reply(ctx, `❌ ${lookup.error}`);
    return;
  }
  const pr = await readPullRequest(repo.cwd, lookup);
  if (isGitError(pr)) {
    await reply(ctx, `❌ ${pr.error}`);
    return;
  }
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: pullRequestCard({
        ...pr,
        checksLabel: checksLabel(pr.checks),
        failingChecks: pr.checks.failing,
        reviewLabel: reviewLabel(pr.reviewDecision),
      }),
    },
    commandReplyOptions(ctx),
  );
}

// ─── knowledge: /memory, /skills, /knowledge ──────────────────────────────
