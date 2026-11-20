import type { ProfileAccess } from '../../config/profile-schema';
import * as configOps from '../../config/config-ops';
import { fetchKnownChats } from '../../bot/lark-info';
import type { CommandContext } from '../types';
import { reply } from '../shared';

export async function handleInvite(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());

  if (tokens.includes('all') && tokens.includes('group')) {
    const list = new Set(ctx.controls.profileConfig.access.allowedChats);
    let knownChats = ctx.controls.knownChats ?? [];
    if (knownChats.length === 0) {
      knownChats = await fetchKnownChats(ctx.channel);
      ctx.controls.knownChats = knownChats;
    }
    let added = 0;
    let total = list.size;
    await saveAccessConfig(ctx, (current) => {
      list.clear();
      for (const chatId of current.allowedChats) list.add(chatId);
      added = 0;
      for (const chat of knownChats) {
        if (!list.has(chat.id)) {
          list.add(chat.id);
          added += 1;
        }
      }
      total = list.size;
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (knownChats.length === 0) {
      await reply(ctx, '当前 bot 还不在任何群里，没有可加入的群。');
    } else {
      await reply(ctx, `✅ 已把 bot 所在的 ${added} 个群加入响应群名单（共 ${total} 个）。`);
    }
    return;
  }

  const kind = tokens.find((token) => /^(user|admin|group|member)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | 'member'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/invite user @某人` — 加入允许私聊\n' +
        '• `/invite admin @某人` — 加入管理员\n' +
        '• `/invite group` — 把当前群加入响应群名单（群内所有人可用）\n' +
        '• `/invite group restricted @某人...` — 把当前群加入响应群名单，且只对 @ 到的人生效（一步到位，不会有"先开放给所有人"的窗口期）\n' +
        '• `/invite member @某人` — 只把这个人加进当前群的专属名单（当前群需已在响应群名单里）\n' +
        '• `/invite all group` — 把 bot 所在的所有群一键加入',
    );
    return;
  }

  if (kind === 'group') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite group` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const restricted = tokens.includes('restricted');

    if (restricted) {
      const targets = mentionTargets(ctx);
      let alreadyChat = false;
      let added: string[] = [];
      let already: string[] = [];
      await saveAccessConfig(ctx, (current) => {
        const chats = new Set(current.allowedChats);
        alreadyChat = chats.has(chatId);
        chats.add(chatId);
        const memberMap = { ...(current.chatAllowedUsers ?? {}) };
        const existing = new Set(memberMap[chatId] ?? []);
        added = [];
        already = [];
        for (const target of targets) {
          if (existing.has(target.openId)) {
            already.push(target.name ?? target.openId);
          } else {
            existing.add(target.openId);
            added.push(target.name ?? target.openId);
          }
        }
        memberMap[chatId] = [...existing];
        return {
          ...current,
          allowedChats: [...chats],
          chatAllowedUsers: memberMap,
        };
      });
      const parts: string[] = [
        alreadyChat
          ? '✅ 当前群已在响应名单里，已切换为仅名单模式。'
          : `✅ 已把当前群（\`${chatId}\`）加入响应群名单，且设为仅名单模式。`,
      ];
      if (added.length > 0) parts.push(`已放行：${added.join('、')}。`);
      if (already.length > 0) parts.push(`_${already.join('、')} 已经在名单里，跳过。_`);
      if (targets.length === 0) {
        parts.push('_当前没有 @ 任何人，这个群现在只有 admin/owner 能用，之后用 `/invite member @某人` 追加。_');
      }
      await reply(ctx, parts.join('\n'));
      return;
    }

    let already = false;
    await saveAccessConfig(ctx, (current) => {
      const list = new Set(current.allowedChats);
      already = list.has(chatId);
      if (!already) list.add(chatId);
      return {
        ...current,
        allowedChats: [...list],
      };
    });
    if (already) {
      await reply(ctx, '✅ 当前群已在白名单里，无需重复添加。');
      return;
    }
    await reply(ctx, `✅ 已把当前群（\`${chatId}\`）加入响应群名单。`);
    return;
  }

  if (kind === 'member') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/invite member` 只能在群里发，在私聊里没有 chat_id 可以加。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const targets = mentionTargets(ctx);
    if (targets.length === 0) {
      await reply(ctx, '❌ 没检测到 @ 的用户。请像这样发：`/invite member @某人`。');
      return;
    }
    let chatAllowed = false;
    let added: string[] = [];
    let already: string[] = [];
    await saveAccessConfig(ctx, (current) => {
      chatAllowed = current.allowedChats.includes(chatId);
      if (!chatAllowed) return current;
      const memberMap = { ...(current.chatAllowedUsers ?? {}) };
      const existing = new Set(memberMap[chatId] ?? []);
      added = [];
      already = [];
      for (const target of targets) {
        if (existing.has(target.openId)) {
          already.push(target.name ?? target.openId);
        } else {
          existing.add(target.openId);
          added.push(target.name ?? target.openId);
        }
      }
      memberMap[chatId] = [...existing];
      return { ...current, chatAllowedUsers: memberMap };
    });
    if (!chatAllowed) {
      await reply(
        ctx,
        '❌ 当前群还不在响应群名单里，先 `/invite group` 或 `/invite group restricted @某人` 再加成员。',
      );
      return;
    }
    const parts: string[] = [];
    if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入当前群的专属名单。`);
    if (already.length > 0) parts.push(`_${already.join('、')} 已经在名单里，跳过。_`);
    await reply(ctx, parts.join('\n'));
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(
      ctx,
      `❌ 没检测到 @ 的用户。请像这样发：\`/invite ${kind} @某人\`（注意 @ 用户不是 @ bot）。`,
    );
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const added: string[] = [];
  const already: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    added.length = 0;
    already.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        already.push(target.name ?? target.openId);
      } else {
        list.add(target.openId);
        added.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (added.length > 0) parts.push(`✅ 已把 ${added.join('、')} 加入${label}。`);
  if (already.length > 0) parts.push(`_${already.join('、')} 已经在${label}里，跳过。_`);
  await reply(ctx, parts.join('\n'));
}

export async function handleRemove(args: string, ctx: CommandContext): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const kind = tokens.find((token) => /^(user|admin|group|member)$/.test(token)) as
    | 'user'
    | 'admin'
    | 'group'
    | 'member'
    | undefined;
  if (!kind) {
    await reply(
      ctx,
      '用法：\n' +
        '• `/remove user @某人` — 移出用户白名单\n' +
        '• `/remove admin @某人` — 移出管理员\n' +
        '• `/remove group` — 把当前群移出响应群名单\n' +
        '• `/remove group <群 ID>` — 按 ID 移除指定的群，私聊里也能用（写 `/config` 群管理面板里显示的末 6 位即可）\n' +
        '• `/remove member @某人` — 把这个人移出当前群的专属名单',
    );
    return;
  }

  if (kind === 'group') {
    const idArg = args.trim().split(/\s+/).find((token) => token.toLowerCase() !== 'group');
    if (idArg) {
      await removeGroupById(ctx, idArg);
      return;
    }
    if (ctx.chatMode === 'p2p') {
      await reply(
        ctx,
        '私聊里请带上群 ID：`/remove group <群 ID>`。ID 写全或只写 `/config` 群管理面板里显示的末 6 位都可以。',
      );
      return;
    }
    const chatId = ctx.msg.chatId;
    let missing = false;
    await saveAccessConfig(ctx, (current) => {
      missing = !current.allowedChats.includes(chatId);
      return withoutChat(current, chatId);
    });
    if (missing) {
      await reply(ctx, '✅ 当前群本来就不在响应名单里，无需移除。');
      return;
    }
    await reply(ctx, '✅ 已把当前群移出响应群名单。');
    return;
  }

  if (kind === 'member') {
    if (ctx.chatMode === 'p2p') {
      await reply(ctx, '❌ `/remove member` 只能在群里发，在私聊里没有 chat_id 可以移除。');
      return;
    }
    const chatId = ctx.msg.chatId;
    const targets = mentionTargets(ctx);
    if (targets.length === 0) {
      await reply(ctx, '请 @ 上要移除的人，例如：`/remove member @某人`。');
      return;
    }
    let hadList = false;
    let removed: string[] = [];
    let notThere: string[] = [];
    await saveAccessConfig(ctx, (current) => {
      const memberMap = { ...(current.chatAllowedUsers ?? {}) };
      const existing = memberMap[chatId];
      hadList = existing !== undefined;
      if (!hadList) return current;
      const set = new Set(existing);
      removed = [];
      notThere = [];
      for (const target of targets) {
        if (set.has(target.openId)) {
          set.delete(target.openId);
          removed.push(target.name ?? target.openId);
        } else {
          notThere.push(target.name ?? target.openId);
        }
      }
      memberMap[chatId] = [...set];
      return { ...current, chatAllowedUsers: memberMap };
    });
    if (!hadList) {
      await reply(ctx, '✅ 当前群不是仅名单模式，没有专属名单，无需移除。');
      return;
    }
    const parts: string[] = [];
    if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出当前群的专属名单。`);
    if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在名单里，无需移除。`);
    await reply(ctx, parts.join('\n'));
    return;
  }

  const targets = mentionTargets(ctx);
  if (targets.length === 0) {
    await reply(ctx, `请 @ 上要移除的人，例如：\`/remove ${kind} @某人\`。`);
    return;
  }

  const listKey = kind === 'user' ? 'allowedUsers' : 'admins';
  const removed: string[] = [];
  const notThere: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    const list = new Set(current[listKey]);
    removed.length = 0;
    notThere.length = 0;
    for (const target of targets) {
      if (list.has(target.openId)) {
        list.delete(target.openId);
        removed.push(target.name ?? target.openId);
      } else {
        notThere.push(target.name ?? target.openId);
      }
    }
    return {
      ...current,
      [listKey]: [...list],
    };
  });
  const label = kind === 'user' ? '用户白名单' : '管理员';
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`✅ 已把 ${removed.join('、')} 移出${label}。`);
  if (notThere.length > 0) parts.push(`${notThere.join('、')} 本来就不在${label}里，无需移除。`);
  await reply(ctx, parts.join('\n'));
}

function mentionTargets(ctx: CommandContext): Array<{ openId: string; name?: string }> {
  return (ctx.msg.mentions ?? [])
    .filter((mention) => !mention.isBot && typeof mention.openId === 'string' && mention.openId)
    .map((mention) => ({
      openId: mention.openId as string,
      ...(mention.name ? { name: mention.name } : {}),
    }));
}

async function saveAccessConfig(
  ctx: CommandContext,
  mutate: (access: ProfileAccess) => ProfileAccess,
): Promise<ProfileAccess> {
  return configOps.saveAccessConfig(ctx.controls, mutate);
}

/**
 * Drop a chat from the allowlist together with its per-chat member list and
 * @ override, so removing then re-adding a group later doesn't silently
 * resurrect settings the operator no longer remembers configuring.
 */
function withoutChat(access: ProfileAccess, chatId: string): ProfileAccess {
  const memberMap = { ...(access.chatAllowedUsers ?? {}) };
  delete memberMap[chatId];
  const mentionMap = { ...(access.chatRequireMention ?? {}) };
  delete mentionMap[chatId];
  return {
    ...access,
    allowedChats: access.allowedChats.filter((id) => id !== chatId),
    chatAllowedUsers: memberMap,
    chatRequireMention: mentionMap,
  };
}

/** Shortest suffix accepted by `/remove group <id>`; the /config panel shows 6. */
const MIN_CHAT_ID_SUFFIX = 4;

/**
 * `/remove group <id>` — removes an allowlisted chat named by its full
 * chat_id or a suffix of it (the /config group panel shows the last 6
 * characters). Works from p2p, which is the only way to drop a chat the bot
 * has already left: plain `/remove group` has to be sent inside the chat.
 */
async function removeGroupById(ctx: CommandContext, rawId: string): Promise<void> {
  const needle = rawId.replace(/^[.…（(]+|[)）]+$/g, '').toLowerCase();
  const names = new Map((ctx.controls.knownChats ?? []).map((chat) => [chat.id, chat.name]));
  const label = (id: string) => `${names.get(id) ? `**${names.get(id)}**` : '(未知群)'}（\`${id}\`）`;
  const findMatches = (allowed: string[]) => {
    const exact = allowed.filter((id) => id.toLowerCase() === needle);
    if (exact.length > 0 || needle.length < MIN_CHAT_ID_SUFFIX) return exact;
    return allowed.filter((id) => id.toLowerCase().endsWith(needle));
  };

  let matches: string[] = [];
  await saveAccessConfig(ctx, (current) => {
    matches = findMatches(current.allowedChats);
    return matches.length === 1 ? withoutChat(current, matches[0]!) : current;
  });

  if (matches.length === 1) {
    await reply(ctx, `✅ 已把 ${label(matches[0]!)} 移出响应群名单。`);
    return;
  }
  if (matches.length > 1) {
    await reply(
      ctx,
      `❌ 有 ${matches.length} 个群的 ID 以 \`${needle}\` 结尾，请多写几位或写全 ID：\n` +
        matches.map((id) => `- ${label(id)}`).join('\n'),
    );
    return;
  }
  await reply(
    ctx,
    needle.length < MIN_CHAT_ID_SUFFIX
      ? `❌ 群 ID 至少写末 ${MIN_CHAT_ID_SUFFIX} 位，或者写全 ID。`
      : `❌ 响应群名单里没有 ID 为 \`${needle}\` 或以它结尾的群。发 \`/config\` 在群管理面板里核对。`,
  );
}

// ────────────── /config — preferences form ──────────────
