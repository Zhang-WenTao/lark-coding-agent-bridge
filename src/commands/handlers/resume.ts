import { randomUUID } from 'node:crypto';
import { agentDescriptor, type AgentKind } from '../../agent/registry';
import { resumeCard } from '../../card/templates';
import { canRunAdminCommand } from '../../policy/access';
import { log } from '../../core/logger';
import { formatRelTime, listRecentSessions, type SessionSummary } from '../../session/history';
import { listCodexThreadHistory, type CodexThreadHistoryEntry } from '../../session/codex-history';
import type { SessionCatalogIdentity } from '../../session/catalog';
import type { CommandContext } from '../types';
import { commandReplyOptions, reply, commandProfilePaths } from '../shared';
import { effectiveWorkspaceCwd } from './workspace';

interface ResumeCandidate {
  scopeId: string;
  agentId: AgentKind;
  cwdRealpath: string;
  policyFingerprint: string;
  sessionId?: string;
  threadId?: string;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;

const resumeCandidates = new Map<string, ResumeCandidate>();

const RESUME_APPLIED_REPLY = '已完成，请继续发送下一条消息。';

export async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return applyResume(rest, ctx);
  }

  // Default: list recent sessions
  const n = Number.parseInt(sub, 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 20 ? n : 5;

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }

  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '群聊中不展示历史会话详情。请私聊 bot 使用 `/resume` 查看和选择历史会话。');
    return;
  }

  await RESUME_LISTS[ctx.controls.profileConfig.agentKind](ctx, cwd, limit, sub);
}

/**
 * `/resume` listing per agent: each reads its own CLI's history and issues
 * resume candidates keyed by that agent's session handle.
 */
const RESUME_LISTS: Record<AgentKind, (ctx: CommandContext, cwd: string, limit: number, sub: string) => Promise<void>> = {
  claude: sendClaudeResumeList,
  codex: sendCodexResumeList,
};

async function sendCodexResumeList(ctx: CommandContext, cwd: string, limit: number): Promise<void> {
  const identity = ctx.sessionCatalogIdentity;
  const entry =
    ctx.sessionCatalog && identity
      ? ctx.sessionCatalog.activeFor(identity)
      : undefined;
  const history = identity ? await listCodexResumeHistory(ctx, cwd, limit) : [];
  if (history.length > 0 && identity) {
    const entries = history.map((thread) => {
      const nonce = issueResumeCandidate(identity, { threadId: thread.threadId });
      return {
        sessionId: nonce,
        preview: thread.name || thread.preview,
        relTime: formatRelTime(thread.updatedAtMs),
        detail: `Codex · ${thread.source}`,
        current: thread.threadId === entry?.threadId,
      };
    });
    const card = resumeCard(cwd, entries);
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }
  if (entry?.threadId && identity) {
    const nonce = issueResumeCandidate(identity, { threadId: entry.threadId });
    await reply(
      ctx,
      `当前 Codex thread 可恢复。\n使用 \`/resume use ${nonce}\` 恢复（10 分钟内有效）。`,
    );
    return;
  }
  const card = resumeCard(cwd, []);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function sendClaudeResumeList(ctx: CommandContext, cwd: string, limit: number, sub = ''): Promise<void> {
  // Only this chat's own conversations: every chat shares the workspace, so
  // the unfiltered list would let anyone resume (and read back) someone
  // else's session. The owner can still see everything with `/resume all`.
  const showAll =
    sub === 'all' && canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok;
  const own = scopeSessionIds(ctx);
  const sessions = showAll
    ? await listClaudeResumeHistory(ctx, cwd, RESUME_SCAN_LIMIT).then((all) => all.slice(0, 20))
    : (await listClaudeResumeHistory(ctx, cwd, RESUME_SCAN_LIMIT))
        .filter((s) => own.has(s.sessionId))
        .slice(0, limit);
  const currentSession = ctx.sessions.getRaw(ctx.scope);
  const identity = ctx.sessionCatalogIdentity;
  const entries = sessions.map((s) => ({
    sessionId: identity
      ? issueResumeCandidate(identity, { sessionId: s.sessionId })
      : s.sessionId,
    displayId: s.sessionId,
    preview: s.preview,
    relTime: formatRelTime(s.mtime),
    lineCount: s.lineCount,
    current: s.sessionId === currentSession?.sessionId,
  }));
  const card = resumeCard(cwd, entries);
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

async function applyResume(sessionId: string, ctx: CommandContext): Promise<void> {
  const descriptor = agentDescriptor(ctx.controls.profileConfig.agentKind);
  if (ctx.sessionCatalog && ctx.sessionCatalogIdentity) {
    const identity = ctx.sessionCatalogIdentity;
    const entry = ctx.sessionCatalog.activeFor(identity);
    const resolved = consumeResumeCandidate(sessionId, identity);
    const handleField = agentDescriptor(identity.agentId).sessionHandle;
    const handle = resolved?.[handleField];
    if (handle) {
      ctx.activeRuns.interrupt(ctx.scope);
      ctx.sessionCatalog.upsertActive({
        scopeId: identity.scopeId,
        agentId: identity.agentId,
        cwdRealpath: identity.cwdRealpath,
        policyFingerprint: identity.policyFingerprint,
        [handleField]: handle,
      });
      if (descriptor.scopeSessionStore) ctx.sessions.set(ctx.scope, handle, identity.cwdRealpath);
      await reply(ctx, RESUME_APPLIED_REPLY);
      return;
    }
    // Without a scope store there is no raw-id path: only a fresh candidate resumes.
    if (!descriptor.scopeSessionStore) {
      await reply(ctx, '当前上下文不可恢复这个会话，请先用 `/resume` 重新生成恢复候选。');
      return;
    }
    const expected = entry?.[handleField];
    if (expected !== sessionId) {
      await reply(ctx, '当前上下文不可恢复这个会话，请重新选择当前工作区和权限策略下的会话。');
      return;
    }
    ctx.activeRuns.interrupt(ctx.scope);
    ctx.sessions.set(ctx.scope, sessionId, identity.cwdRealpath);
    await reply(ctx, RESUME_APPLIED_REPLY);
    return;
  }

  if (!descriptor.scopeSessionStore) {
    await reply(ctx, `当前上下文没有可恢复的 ${descriptor.displayName} 会话，请先在当前工作区完成一次运行。`);
    return;
  }

  const cwd = selectedResumeCwd(ctx);
  if (!cwd) {
    await reply(ctx, '请先使用 /cd <path> 选择工作目录，再查看或恢复会话。');
    return;
  }
  ctx.activeRuns.interrupt(ctx.scope);
  ctx.sessions.set(ctx.scope, sessionId, cwd);
  await reply(ctx, RESUME_APPLIED_REPLY);
}

function issueResumeCandidate(
  identity: SessionCatalogIdentity,
  target: { sessionId: string } | { threadId: string },
): string {
  pruneResumeCandidates();
  let nonce = randomUUID().slice(0, 12);
  while (resumeCandidates.has(nonce)) nonce = randomUUID().slice(0, 12);
  resumeCandidates.set(nonce, {
    scopeId: identity.scopeId,
    agentId: identity.agentId,
    cwdRealpath: identity.cwdRealpath,
    policyFingerprint: identity.policyFingerprint,
    ...target,
    expiresAt: Date.now() + RESUME_CANDIDATE_TTL_MS,
  });
  return nonce;
}

function consumeResumeCandidate(
  nonce: string,
  identity: SessionCatalogIdentity,
): ResumeCandidate | undefined {
  pruneResumeCandidates();
  const candidate = resumeCandidates.get(nonce);
  if (!candidate) return undefined;
  resumeCandidates.delete(nonce);
  if (
    candidate.scopeId !== identity.scopeId ||
    candidate.agentId !== identity.agentId ||
    candidate.cwdRealpath !== identity.cwdRealpath ||
    candidate.policyFingerprint !== identity.policyFingerprint ||
    !candidate[agentDescriptor(identity.agentId).sessionHandle]
  ) {
    return undefined;
  }
  return candidate;
}

function pruneResumeCandidates(now = Date.now()): void {
  for (const [nonce, candidate] of resumeCandidates.entries()) {
    if (candidate.expiresAt <= now) resumeCandidates.delete(nonce);
  }
}

/** How far back `/resume` looks before keeping only this chat's sessions. */
const RESUME_SCAN_LIMIT = 200;

/** Claude sessions this chat has used: its current one and any it moved on from. */
function scopeSessionIds(ctx: CommandContext): Set<string> {
  const ids = new Set<string>();
  const current = ctx.sessions.getRaw(ctx.scope)?.sessionId;
  if (current) ids.add(current);
  for (const entry of ctx.sessionCatalog?.entries() ?? []) {
    if (entry.scopeId === ctx.scope && entry.agentId === ctx.controls.profileConfig.agentKind && entry.sessionId) {
      ids.add(entry.sessionId);
    }
  }
  return ids;
}

async function listClaudeResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<SessionSummary[]> {
  const provider = ctx.claudeHistoryProvider ?? listRecentSessions;
  return provider(cwd, limit);
}

async function listCodexResumeHistory(
  ctx: CommandContext,
  cwd: string,
  limit: number,
): Promise<CodexThreadHistoryEntry[]> {
  const codex = ctx.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return [];

  const provider = ctx.codexHistoryProvider ?? listCodexThreadHistory;
  try {
    return await provider({
      binary,
      cwd,
      limit,
      profileStateDir: commandProfilePaths(ctx).profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
  } catch (err) {
    log.warn('session', 'codex-history-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function selectedResumeCwd(ctx: CommandContext): string | undefined {
  return effectiveWorkspaceCwd(ctx);
}
