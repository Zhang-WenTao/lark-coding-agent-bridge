import { canRunCommandInChat } from '../policy/access';
import { log, reportMetric } from '../core/logger';
import { isPlainCoffeeRequest } from './coffee-intent';
import type { CommandContext } from './types';
import { reply } from './shared';
import { handleCd, handleDoc, handleNew, handleWs } from './handlers/workspace';
import { handleResume } from './handlers/resume';
import { handleStatus } from './handlers/status';
import {
  handleExit,
  handlePs,
  handleReconnect,
  handleStop,
  handleTimeout,
} from './handlers/lifecycle';
import { handleDoctor } from './handlers/doctor';
import { handleAccounts, handleApproval, handleHelp, handleUsage } from './handlers/usage';
import { handleDream } from './handlers/dream';
import { handleAudit } from './handlers/audit';
import { handleCoffee, handleCopyCode } from './handlers/misc';
import { handleDiff, handlePr, handleWorktree } from './handlers/git';
import { handleKnowledge, handleMemory, handleSkills } from './handlers/knowledge';
import { handleCron } from './handlers/cron';
import { handleAccount } from './handlers/account';
import { handleInvite, handleRemove } from './handlers/access';
import { handleConfig } from './handlers/config';
import { handleMeeting } from './handlers/meeting';

export type { CommandContext, Controls } from './types';

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  '/new': handleNew,
  '/reset': handleNew,
  '/cd': handleCd,
  '/ws': handleWs,
  '/resume': handleResume,
  '/status': handleStatus,
  '/help': handleHelp,
  '/account': handleAccount,
  '/accounts': handleAccounts,
  '/config': handleConfig,
  '/stop': handleStop,
  '/copycode': handleCopyCode,
  '/timeout': handleTimeout,
  '/ps': handlePs,
  '/exit': handleExit,
  '/doctor': handleDoctor,
  '/reconnect': handleReconnect,
  '/doc': handleDoc,
  '/invite': handleInvite,
  '/remove': handleRemove,
  '/meeting': handleMeeting,
  '/diff': handleDiff,
  '/worktree': handleWorktree,
  '/pr': handlePr,
  '/memory': handleMemory,
  '/skills': handleSkills,
  '/knowledge': handleKnowledge,
  '/cron': handleCron,
  '/coffee': handleCoffee,
  '/usage': handleUsage,
  '/audit': handleAudit,
  '/practice': handleDream,
  // Renamed to /practice (11-20); only says so, does nothing else.
  '/dream': (args, ctx) => reply(ctx, `\`/dream\` 已改名为 \`/practice\`，用法不变：发 \`/practice${args.trim() ? ` ${args.trim()}` : ''}\`。`),
  // Card buttons of approval prompts (not typed by people; see ApprovalBroker).
  '/approval': handleApproval,
};

/**
 * Commands that can mutate credentials, lifecycle, filesystem reach, or
 * surface sensitive runtime state. Gated by unified access policy; runtime
 * owner is always allowed, while empty admin list means no listed admins.
 */
const ADMIN_COMMANDS = new Set([
  '/account',
  // Shows the owner's subscription quotas and changes which account pays;
  // `access.commandChats` may open it to everyone in chosen chats.
  '/accounts',
  '/config',
  '/ps',
  '/exit',
  '/reconnect',
  '/doctor',
  '/cd',
  '/ws',
  '/invite',
  '/remove',
  // These read repository contents into the chat and create directories on the
  // host, so they sit at the same level as /cd and /ws.
  '/diff',
  '/worktree',
  '/pr',
  // Binding / syncing the knowledge repo moves content between machines and
  // rewrites what every chat in this profile sees.
  '/knowledge',
  // A scheduled job runs the agent unattended with the profile's full
  // permissions, so creating one is at least as sensitive as /cd.
  '/cron',
  // Joining a meeting makes the bot visible to every participant and exposes
  // meeting content to the agent — owner/admin only.
  '/meeting',
  // Shows who had the bot do what across every chat of the profile.
  '/audit',
  // Reads every chat's conversations and opens PRs against shared repositories.
  '/practice',
  '/dream',
]);

function isAdminCommand(cmd: string): boolean {
  return ADMIN_COMMANDS.has(cmd.startsWith('/') ? cmd : `/${cmd}`);
}

/** Owner/admin, or anyone in a chat `access.commandChats` opens the command in. */
function canRunCommand(cmd: string, ctx: CommandContext): boolean {
  return canRunCommandInChat(ctx.controls.profileConfig, ctx.controls, cmd, ctx.msg.chatId, ctx.msg.senderId).ok;
}

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.msg.content.trim();
  if (!trimmed.startsWith('/')) {
    if (isPlainCoffeeRequest(trimmed, ctx.msg.mentions, ctx.channel.botIdentity?.openId)) {
      await handleCoffee('', ctx);
      return true;
    }
    return false;
  }
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = parts.slice(1).join(' ');
  const h = handlers[cmd];
  if (!h) return false;
  if (isAdminCommand(cmd) && !canRunCommand(cmd, ctx)) {
    log.info('command', 'admin-deny', {
      cmd,
      sender: ctx.msg.senderId.slice(-6),
    });
    await reply(ctx, '❌ 此命令仅管理员可用。');
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd });
    reportMetric('command_fail', 1, { step: 'dispatch' });
  }
  return true;
}

/** Invoke a named command handler (e.g. from a card button click). */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const h = handlers[`/${name}`];
  if (!h) return false;
  if (isAdminCommand(name) && !canRunCommand(`/${name}`, ctx)) {
    log.info('command', 'admin-deny', {
      cmd: name,
      sender: ctx.msg.senderId.slice(-6),
      via: 'card',
    });
    // Card actions can't reply naturally (the `msg` is synthesized); the
    // click is silently denied. The button only renders for users who got
    // the original admin card in the first place, so this is an edge case.
    return true;
  }
  try {
    await h(args, ctx);
  } catch (err) {
    log.fail('command', err, { cmd: name });
    reportMetric('command_fail', 1, { step: 'handler' });
  }
  return true;
}
