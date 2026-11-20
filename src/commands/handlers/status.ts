import { readFile } from 'node:fs/promises';
import { agentDescriptor } from '../../agent/registry';
import { statusCard, taskStatusCard, type StatusInfo } from '../../card/templates';
import { getSmartSession } from '../../config/schema';
import type { ProfileConfig } from '../../config/profile-schema';
import { describeActiveRun } from '../../bot/run-status';
import { formatMoment, limitLabel } from '../../bot/auto-resume';
import { accessToClaudePermissionMode } from '../../config/permissions';
import { canRunAdminCommand } from '../../policy/access';
import { decideRotation } from '../../session/smart-session';
import { probeAgentSession } from '../../agent/session-probe';
import { hasStructuredLarkCliUserAuth } from '../../lark-cli/identity-policy';
import type { CommandContext } from '../types';
import { commandReplyOptions, commandProfilePaths } from '../shared';
import { effectiveWorkspaceCwd } from './workspace';
import { gitStatusLine } from './git';
import { knowledgeStatusLine } from './knowledge';

export function runtimeAccessStatus(
  profileConfig: ProfileConfig,
): { label: string; value: string } {
  if (agentDescriptor(profileConfig.agentKind).accessControl === 'permission-mode') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profileConfig.permissions.defaultAccess,
        profileConfig.permissions,
      ),
    };
  }
  return {
    label: 'sandbox',
    value: `${profileConfig.sandbox.defaultMode}/${profileConfig.sandbox.maxMode}`,
  };
}

async function larkCliStatus(ctx: CommandContext): Promise<'app' | 'user-ready' | 'user-missing' | 'check-failed'> {
  const appPaths = commandProfilePaths(ctx);
  try {
    const raw = JSON.parse(await readFile(appPaths.larkCliTargetConfigFile, 'utf8')) as {
      apps?: Array<{
        appId?: string;
        brand?: string;
        defaultAs?: string;
        strictMode?: string;
        users?: unknown;
      }>;
    };
    const app = raw.apps?.find(
      (candidate) =>
        candidate.appId === ctx.controls.profileConfig.accounts.app.id &&
        candidate.brand === ctx.controls.profileConfig.accounts.app.tenant,
    );
    if (app?.defaultAs === 'auto' && app.strictMode === 'off' && hasStructuredLarkCliUserAuth(app.users)) {
      return 'user-ready';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'check-failed';
  }
  if (
    ctx.controls.profileConfig.larkCli.identityPreset === 'user-default' &&
    canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok
  ) {
    return 'user-missing';
  }
  return 'app';
}

export async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const cwd = effectiveWorkspaceCwd(ctx);
  const activeHandle = ctx.activeRuns.get(ctx.scope);
  const pendingResume = ctx.autoResumer?.get(ctx.scope);
  // Workspace paths, session ids, git and account state are the owner's
  // business; everyone else only needs to know how their task is doing.
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    const card = taskStatusCard({
      ...(activeHandle ? { activeRun: describeActiveRun(activeHandle) } : {}),
      ...(pendingResume
        ? {
            autoResume: `${limitLabel(pendingResume.limitType)}用完暂停，${formatMoment(pendingResume.resumeAt)} 自动继续（发 /stop 取消）`,
          }
        : {}),
    });
    await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
    return;
  }
  const sess = ctx.sessions.getRaw(ctx.scope);
  // Scope-store agents report the scope's session (and whether its cwd went
  // stale); the rest report the catalog entry for the current context.
  const descriptor = agentDescriptor(ctx.controls.profileConfig.agentKind);
  const catalogEntry =
    !descriptor.scopeSessionStore && ctx.sessionCatalog && ctx.sessionCatalogIdentity
      ? ctx.sessionCatalog.activeFor(ctx.sessionCatalogIdentity)
      : undefined;
  const sessionId = descriptor.scopeSessionStore ? sess?.sessionId : catalogEntry?.[descriptor.sessionHandle];
  const sessionStale = descriptor.scopeSessionStore && Boolean(cwd && sess && sess.cwd !== cwd);
  const card = statusCard({
    profileName: ctx.controls.profile,
    cwd,
    sessionId,
    emptySessionText: descriptor.scopeSessionStore ? undefined : '(未建立)',
    sessionStale,
    ...(sessionId && !sessionStale
      ? await sessionContextStatus(ctx, sessionId, (descriptor.scopeSessionStore ? sess?.cwd : undefined) ?? cwd)
      : {}),
    agentName: ctx.agent.displayName,
    runtimeAccess: runtimeAccessStatus(ctx.controls.profileConfig),
    larkCliStatus: await larkCliStatus(ctx),
    ...(await gitStatusLine(cwd)),
    ...(await knowledgeStatusLine(ctx)),
    activeRun: Boolean(ctx.activeRuns.get(ctx.scope)),
    ...(activeHandle ? { activeRunDetail: describeActiveRun(activeHandle) } : {}),
    ...(pendingResume
      ? {
          autoResume: `${limitLabel(pendingResume.limitType)}用完暂停，${formatMoment(pendingResume.resumeAt)} 自动继续（发 /stop 取消）`,
        }
      : {}),
    backgroundRun: ctx.activeRuns.isLingering(ctx.scope),
    activeScopes: ctx.activeRuns.scopes().filter((scope) => !scope.startsWith('comment:')),
    activeCommentScopes: ctx.activeRuns.scopes().filter((scope) => scope.startsWith('comment:')),
    queue: ctx.processPool?.snapshot(),
    ownerState: formatOwnerState(ctx),
    scope: ctx.scope,
    chatMode: ctx.chatMode,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, commandReplyOptions(ctx));
}

/**
 * How big the conversation the next message would resume has grown, and —
 * with 会话智能压缩 on — whether that message will start a fresh one instead.
 * Read from the agent's own transcript; absent when it can't be read.
 */
async function sessionContextStatus(
  ctx: CommandContext,
  handle: string,
  cwd: string | undefined,
): Promise<Pick<StatusInfo, 'context'>> {
  if (!cwd) return {};
  const probe = await probeAgentSession(ctx.controls.profileConfig, handle, cwd);
  if (!probe || (probe.contextTokens === undefined && probe.lastActivityAt === undefined)) return {};
  const now = Date.now();
  const smartSession = getSmartSession(ctx.controls.cfg);
  const pending = ctx.controls.pendingRotations?.get(ctx.scope);
  const verdict =
    smartSession && !ctx.runExecutor?.hasLiveProcess(ctx.scope)
      ? decideRotation({ settings: smartSession, probe, ...(pending ? { pending } : {}), resumeHandle: handle, now })
      : undefined;
  return {
    context: {
      ...(probe.contextTokens !== undefined ? { tokens: probe.contextTokens } : {}),
      ...(probe.lastActivityAt !== undefined
        ? { idleMinutes: Math.max(0, Math.floor((now - probe.lastActivityAt) / 60_000)) }
        : {}),
      ...(verdict ? { rotateReason: verdict.reason } : {}),
    },
  };
}

export function formatOwnerState(ctx: CommandContext): string {
  const state = ctx.controls.ownerRefreshState;
  const owner = ctx.controls.botOwnerId ? 'present' : 'missing';
  const refreshed = ctx.controls.ownerRefreshedAt
    ? ` refreshed=${new Date(ctx.controls.ownerRefreshedAt).toISOString()}`
    : '';
  return `${state} owner=${owner}${refreshed}`;
}
