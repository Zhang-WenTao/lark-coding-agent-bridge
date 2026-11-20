import {
  knowledgeRepoStatus,
  bindKnowledgeRemote,
  knowledgeRemoteUrl,
  syncKnowledge,
  unbindKnowledgeRemote,
} from '../../knowledge/sync';
import { log } from '../../core/logger';
import type { CommandContext } from '../types';
import {
  DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES,
  getKnowledgeSyncIntervalMinutes,
} from '../../knowledge/auto-sync';
import {
  buildLibraryConfig,
  getSkillSyncIntervalMinutes,
  maskUrlCredentials,
  shadowedSkills,
  type SkillLibraries,
} from '../../knowledge/libraries';
import type { KnowledgeStore, MemoryScope } from '../../knowledge/store';
import {
  knowledgeCard,
  type KnowledgeStatusView,
  memoryCard,
  skillLibrariesCard,
  skillsCard,
} from '../../card/templates';
import { isGitError } from '../../git/exec';
import { isDirty } from '../../git/status';
import type { SkillLibraryConfig } from '../../config/profile-schema';
import { canRunAdminCommand } from '../../policy/access';
import * as configOps from '../../config/config-ops';
import { formatAgoCompact } from '../../core/time-format';
import { commandReplyOptions, reply } from '../shared';

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

function requireKnowledge(ctx: CommandContext): KnowledgeStore | undefined {
  return ctx.controls.knowledge;
}

export async function handleMemory(args: string, ctx: CommandContext): Promise<void> {
  const store = requireKnowledge(ctx);
  if (!store) {
    await reply(ctx, '当前 bridge 没有启用知识库（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);
  const restText = trimmed.slice(sub.length).trim();

  switch (sub) {
    case '':
    case 'list':
      return memoryList(ctx, store);
    case 'add':
      return memoryAdd(restText, ctx, store);
    case 'forget':
    case 'rm':
      return memoryForget(rest[0] ?? '', ctx, store);
    case 'clear':
      return memoryClear(restText, ctx, store);
    default:
      await reply(
        ctx,
        [
          '**记忆**',
          '',
          '`/memory` — 看当前生效的记忆',
          '`/memory add <内容>` — 记到本会话',
          '`/memory add --global <内容>` — 记到全局（管理员）',
          '`/memory forget <id>` — 删一条',
          '`/memory clear [--global]` — 清空一个范围',
        ].join('\n'),
      );
  }
}

async function memoryList(ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const [chat, profile] = await Promise.all([
    store.listMemories({ kind: 'chat', scopeId: ctx.scope }),
    store.listMemories({ kind: 'profile' }),
  ]);
  await ctx.channel.send(
    ctx.msg.chatId,
    { card: memoryCard({ chat, profile, dir: store.dir }) },
    commandReplyOptions(ctx),
  );
}

async function memoryAdd(args: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const global = /^--global\b/.test(args);
  const text = global ? args.replace(/^--global\b/, '').trim() : args.trim();
  if (!text) {
    await reply(ctx, '用法：`/memory add <要记住的内容>`（加 `--global` 记到全局）');
    return;
  }
  // Global memory reaches every chat this profile serves, so it is an admin
  // action; a note about the current conversation is not.
  if (global && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 全局记忆仅管理员可写，去掉 `--global` 可以记到本会话。');
    return;
  }

  const scope: MemoryScope = global ? { kind: 'profile' } : { kind: 'chat', scopeId: ctx.scope };
  const entry = await store.addMemory(scope, text);
  log.info('knowledge', 'memory-added', { scope: global ? 'profile' : ctx.scope, id: entry.id });
  await reply(
    ctx,
    `🧠 已记住（${global ? '全局' : '本会话'}）：${entry.text}\n\n\`/memory forget ${entry.id}\` 可以撤销。`,
  );
}

async function memoryForget(id: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  if (!id) {
    await reply(ctx, '用法：`/memory forget <id>`（id 在 `/memory` 列表里）');
    return;
  }
  if (await store.removeMemory({ kind: 'chat', scopeId: ctx.scope }, id)) {
    await reply(ctx, `🗑 已删除本会话记忆 \`${id}\`。`);
    return;
  }
  // Falling through to profile scope only for admins keeps a group member from
  // deleting a global rule by guessing an id.
  if (canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    if (await store.removeMemory({ kind: 'profile' }, id)) {
      await reply(ctx, `🗑 已删除全局记忆 \`${id}\`。`);
      return;
    }
  }
  await reply(ctx, `没找到 \`${id}\`。`);
}

async function memoryClear(args: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const global = /^--global\b/.test(args.trim());
  if (global && !canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ 全局记忆仅管理员可改。');
    return;
  }
  const scope: MemoryScope = global ? { kind: 'profile' } : { kind: 'chat', scopeId: ctx.scope };
  const removed = await store.clearMemories(scope);
  await reply(ctx, removed === 0 ? '本来就没有记忆。' : `🗑 已清空 ${removed} 条${global ? '全局' : '本会话'}记忆。`);
}

export async function handleSkills(args: string, ctx: CommandContext): Promise<void> {
  const store = requireKnowledge(ctx);
  if (!store) {
    await reply(ctx, '当前 bridge 没有启用知识库（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);

  if (sub === 'lib' || sub === 'libs') {
    return handleSkillLibraries(trimmed.slice(sub.length).trim(), ctx, store);
  }

  if (sub === 'show' || sub === 'cat') {
    const name = rest.join(' ').trim();
    const skill = name ? await store.readSkill(name) : undefined;
    if (!skill) {
      await reply(ctx, `没找到 skill \`${name || '(未指定)'}\`，用 \`/skills\` 看看列表。`);
      return;
    }
    const body = skill.body.length > 3000 ? `${skill.body.slice(0, 3000)}\n\n…（截断，完整内容见 ${skill.summary.path}）` : skill.body;
    await reply(ctx, body);
    return;
  }

  const skills = await store.listSkills();
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: skillsCard(
        skills.map(({ name, description, source }) => ({ name, description, ...(source ? { source } : {}) })),
        store.skillsDir,
      ),
    },
    commandReplyOptions(ctx),
  );
}

// ─── /skills lib: shared skill libraries ──────────────────────────────────

const SKILL_LIB_HELP = [
  '**Skill 库**（管理员）',
  '',
  '`/skills lib` — 已配置的库、同步状态、各自载入的 skill',
  '`/skills lib add <git 地址> [名字] [--ref 分支/标签/提交] [--path 子目录] [--only a,b] [--exclude a,b]` — 加一个库并立即拉取',
  '`/skills lib sync [名字]` — 立即同步（不写名字就是全部）',
  '`/skills lib rm <名字>` — 移除，本地镜像一起删掉',
  '',
  '库是 git 仓库的只读镜像：skill 放在 `skills/<名字>/SKILL.md`（没有 `skills/` 就在仓库根目录找），同名时本 profile 自己的 skill 优先、先加的库优先。私有仓库用本机已配好的 SSH key 访问，不要把 token 写进地址。',
].join('\n');

async function handleSkillLibraries(args: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  // A library feeds instructions straight into every run of this profile and
  // makes the host fetch from an arbitrary URL — same level as /knowledge.
  if (!canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId).ok) {
    await reply(ctx, '❌ skill 库仅管理员可管理；`/skills` 可以查看已载入的 skill。');
    return;
  }
  const libraries = ctx.controls.skillLibraries;
  if (!libraries) {
    await reply(ctx, '当前 bridge 没有启用 skill 库（缺少 profile 数据目录）。');
    return;
  }
  const [sub = '', ...rest] = args.split(/\s+/).filter(Boolean);
  switch (sub) {
    case '':
    case 'list':
    case 'status':
      return skillLibraryList(ctx, store, libraries);
    case 'add':
      return skillLibraryAdd(rest, ctx, store, libraries);
    case 'sync':
    case 'pull':
      return skillLibrarySync(rest[0], ctx, libraries);
    case 'rm':
    case 'remove':
      return skillLibraryRemove(rest[0] ?? '', ctx, libraries);
    default:
      await reply(ctx, SKILL_LIB_HELP);
  }
}

function configuredLibraries(ctx: CommandContext): SkillLibraryConfig[] {
  return ctx.controls.profileConfig.skills?.libraries ?? [];
}

async function skillLibraryList(
  ctx: CommandContext,
  store: KnowledgeStore,
  libraries: SkillLibraries,
): Promise<void> {
  const [statuses, merged] = await Promise.all([libraries.status(), store.listSkills()]);
  const now = Date.now();
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: skillLibrariesCard(
        statuses.map((status) => ({
          name: status.config.name,
          url: maskUrlCredentials(status.config.url),
          ...(status.config.ref ? { ref: status.config.ref } : {}),
          ...(status.config.path ? { path: status.config.path } : {}),
          ...(status.config.include ? { include: status.config.include } : {}),
          ...(status.config.exclude ? { exclude: status.config.exclude } : {}),
          present: status.present,
          ...(status.commit ? { commit: status.commit } : {}),
          ...(status.commitAt ? { commitAgo: formatAgoCompact(now - status.commitAt) } : {}),
          ...(status.lastSyncAt ? { lastSyncAgo: formatAgoCompact(now - status.lastSyncAt) } : {}),
          ...(status.lastError ? { lastError: status.lastError } : {}),
          skills: status.skills.map((skill) => skill.name),
          shadowed: shadowedSkills(status, merged),
        })),
        getSkillSyncIntervalMinutes(ctx.controls.profileConfig.skills),
      ),
    },
    commandReplyOptions(ctx),
  );
}

type ParsedLibraryAdd = { library: SkillLibraryConfig } | { error: string };

/** `<url> [name] [--ref x] [--path x] [--only a,b] [--exclude a,b] [--name x]`. */
function parseLibraryAdd(tokens: string[], taken: Set<string>): ParsedLibraryAdd {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const flag = /^--(ref|path|only|include|exclude|name)(?:=(.*))?$/.exec(token);
    if (flag) {
      const value = flag[2] ?? tokens[i + 1];
      if (flag[2] === undefined) i += 1;
      if (!value) return { error: `\`--${flag[1]}\` 后面缺少值。` };
      flags[flag[1] === 'include' ? 'only' : flag[1]!] = value;
      continue;
    }
    if (token.startsWith('--')) return { error: `不认识的参数 \`${token}\`。` };
    positional.push(token);
  }
  const url = positional[0] ?? '';
  if (!url) return { error: '用法：`/skills lib add <git 地址> [名字]`' };
  const list = (value: string | undefined) => value?.split(',');
  return buildLibraryConfig(
    {
      url,
      name: flags.name ?? positional[1],
      ref: flags.ref,
      path: flags.path,
      include: list(flags.only),
      exclude: list(flags.exclude),
    },
    taken,
  );
}

async function skillLibraryAdd(
  tokens: string[],
  ctx: CommandContext,
  store: KnowledgeStore,
  libraries: SkillLibraries,
): Promise<void> {
  const parsed = parseLibraryAdd(tokens, new Set(configuredLibraries(ctx).map((library) => library.name)));
  if (!('library' in parsed)) {
    await reply(ctx, `❌ ${parsed.error}\n\n${SKILL_LIB_HELP}`);
    return;
  }
  const library = parsed.library;

  // Fetch first and only then save: a library that cannot be pulled never
  // lands in the configuration.
  const result = await libraries.syncLibrary(library);
  if (!result.ok) {
    await reply(ctx, `❌ 拉取 \`${library.name}\` 失败：${result.error ?? '未知错误'}`);
    return;
  }
  try {
    await configOps.saveSkillsConfig(ctx.controls, (skills) => ({
      ...skills,
      libraries: [...skills.libraries.filter((item) => item.name !== library.name), library],
    }));
  } catch (err) {
    await libraries.remove(library.name).catch(() => undefined);
    await reply(ctx, `❌ 保存配置失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  log.info('skills', 'library-added', { library: library.name, by: ctx.msg.senderId });

  const [statuses, merged] = await Promise.all([libraries.status(), store.listSkills()]);
  const status = statuses.find((item) => item.config.name === library.name);
  const found = status?.skills.length ?? 0;
  const shadowed = status ? shadowedSkills(status, merged) : [];
  const interval = getSkillSyncIntervalMinutes(ctx.controls.profileConfig.skills);
  const lines = [
    `📚 已添加 skill 库 \`${library.name}\`（\`${result.commit ?? '?'}\`），载入 ${found - shadowed.length} 个 skill。`,
  ];
  if (found === 0) {
    lines.push('⚠️ 没找到 `SKILL.md`：skill 要放在 `<目录>/<名字>/SKILL.md`，不在 `skills/` 下就用 `--path` 指定目录。');
  }
  if (shadowed.length > 0) {
    lines.push(`同名已存在、未载入：${shadowed.map((name) => `\`${name}\``).join('、')}`);
  }
  lines.push(
    '',
    `下一条消息起生效。${interval > 0 ? `每 ${interval} 分钟自动同步，` : ''}\`/skills lib sync ${library.name}\` 立即同步。`,
  );
  await reply(ctx, lines.join('\n'));
}

async function skillLibrarySync(name: string | undefined, ctx: CommandContext, libraries: SkillLibraries): Promise<void> {
  const configured = configuredLibraries(ctx);
  if (configured.length === 0) {
    await reply(ctx, '还没有配置 skill 库，用 `/skills lib add <git 地址>` 添加。');
    return;
  }
  if (name && !configured.some((library) => library.name === name)) {
    await reply(ctx, `没有叫 \`${name}\` 的库。现有：${configured.map((library) => `\`${library.name}\``).join('、')}`);
    return;
  }
  const results = await libraries.sync(name);
  const lines = results.map((result) =>
    result.ok
      ? `✓ \`${result.name}\`：${result.changed ? '已更新到' : '已是最新'} \`${result.commit ?? '?'}\``
      : `❌ \`${result.name}\`：${result.error ?? '同步失败'}`,
  );
  await reply(ctx, `🔄 skill 库同步完成\n${lines.join('\n')}`);
}

async function skillLibraryRemove(name: string, ctx: CommandContext, libraries: SkillLibraries): Promise<void> {
  const configured = configuredLibraries(ctx);
  if (!name) {
    await reply(ctx, '用法：`/skills lib rm <名字>`');
    return;
  }
  if (!configured.some((library) => library.name === name)) {
    await reply(
      ctx,
      configured.length === 0
        ? '还没有配置 skill 库。'
        : `没有叫 \`${name}\` 的库。现有：${configured.map((library) => `\`${library.name}\``).join('、')}`,
    );
    return;
  }
  try {
    await configOps.saveSkillsConfig(ctx.controls, (skills) => ({
      ...skills,
      libraries: skills.libraries.filter((library) => library.name !== name),
    }));
  } catch (err) {
    await reply(ctx, `❌ 保存配置失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await libraries.remove(name);
  log.info('skills', 'library-removed', { library: name, by: ctx.msg.senderId });
  await reply(ctx, `🗑 已移除 skill 库 \`${name}\`，本地镜像一起删掉了。`);
}

export async function handleKnowledge(args: string, ctx: CommandContext): Promise<void> {
  const store = requireKnowledge(ctx);
  if (!store) {
    await reply(ctx, '当前 bridge 没有启用知识库（缺少 profile 数据目录）。');
    return;
  }
  const trimmed = args.trim();
  const [sub = '', ...rest] = trimmed.split(/\s+/);

  switch (sub) {
    case '':
    case 'status':
      return knowledgeStatus(ctx, store);
    case 'bind':
      return knowledgeBind(rest[0] ?? '', ctx, store);
    case 'unbind': {
      const result = await unbindKnowledgeRemote(store);
      await reply(ctx, isGitError(result) ? `❌ ${result.error}` : '✓ 已解除远端绑定，本地内容保留。');
      return;
    }
    case 'sync':
      return knowledgeSync(ctx, store);
    default:
      await reply(
        ctx,
        [
          '**知识库**',
          '',
          '`/knowledge` — 当前状态（记忆条数、skill 数、同步状态）',
          '`/knowledge bind <git 仓库地址>` — 绑定远端并拉取已有内容',
          '`/knowledge sync` — 立即同步：提交本地改动、拉取远端、推上去',
          '`/knowledge unbind` — 解除绑定（本地内容保留）',
          '',
          knowledgeAutoSyncHelp(getKnowledgeSyncIntervalMinutes(ctx.controls.profileConfig.knowledge)),
        ].join('\n'),
      );
  }
}

async function knowledgeStatus(ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  const [chat, profile, skills, repo, remote] = await Promise.all([
    store.listMemories({ kind: 'chat', scopeId: ctx.scope }),
    store.listMemories({ kind: 'profile' }),
    store.listSkills(),
    knowledgeRepoStatus(store),
    knowledgeRemoteUrl(store),
  ]);
  await ctx.channel.send(
    ctx.msg.chatId,
    {
      card: knowledgeCard({
        dir: store.dir,
        chatMemories: chat.length,
        profileMemories: profile.length,
        skills: skills.length,
        ...(remote ? { remote } : {}),
        ...(repo?.branch ? { branch: repo.branch } : {}),
        ...(repo?.upstream ? { ahead: repo.upstream.ahead, behind: repo.upstream.behind } : {}),
        ...(repo ? { dirty: isDirty(repo) } : {}),
        ...knowledgeAutoSyncView(ctx),
      }),
    },
    commandReplyOptions(ctx),
  );
}

function knowledgeAutoSyncHelp(interval: number): string {
  const now = interval > 0 ? `绑定远端后每 ${interval} 分钟自动同步一次` : '自动同步已关闭';
  return `${now}（profile 配置 \`knowledge.syncIntervalMinutes\`，默认 ${DEFAULT_KNOWLEDGE_SYNC_INTERVAL_MINUTES}，\`0\` 关闭）；连续两次失败会私聊提醒 bot 主人。`;
}

/** Auto-sync part of the `/knowledge` card; the interval is shown even before the loop exists. */
function knowledgeAutoSyncView(
  ctx: CommandContext,
): Pick<KnowledgeStatusView, 'autoSyncMinutes' | 'autoSyncing' | 'lastSync'> {
  const status = ctx.controls.knowledgeAutoSync?.status();
  const view = {
    autoSyncMinutes: status?.intervalMinutes ?? getKnowledgeSyncIntervalMinutes(ctx.controls.profileConfig.knowledge),
    ...(status?.syncing ? { autoSyncing: true } : {}),
  };
  const last = status?.last;
  if (!status || !last) return view;
  return {
    ...view,
    lastSync: {
      ago: formatAgoCompact(Date.now() - last.at),
      auto: last.trigger === 'auto',
      ok: last.ok,
      ...(last.error ? { error: last.error } : {}),
      ...(status.failures > 1 ? { failures: status.failures } : {}),
    },
  };
}

async function knowledgeBind(url: string, ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  if (!url) {
    await reply(ctx, '用法：`/knowledge bind <git 仓库地址>`');
    return;
  }
  const result = await bindKnowledgeRemote(store, url);
  if (isGitError(result)) {
    await reply(ctx, `❌ 绑定失败：${result.error}`);
    return;
  }
  log.info('knowledge', 'remote-bound', { scope: ctx.scope });
  const interval = getKnowledgeSyncIntervalMinutes(ctx.controls.profileConfig.knowledge);
  const after = interval > 0 ? `之后每 ${interval} 分钟自动同步，也可以随时 \`/knowledge sync\`。` : '之后用 `/knowledge sync` 同步。';
  await reply(ctx, `🔗 已绑定远端。${result.note ?? '远端已有的记忆和 skill 都拉下来了。'}\n\n${after}`);
}

async function knowledgeSync(ctx: CommandContext, store: KnowledgeStore): Promise<void> {
  // Queued behind an automatic sync that is already running, then a full
  // round of its own (`syncKnowledge` serializes per directory).
  const result = await syncKnowledge(store);
  ctx.controls.knowledgeAutoSync?.noteManual(result);
  if (isGitError(result)) {
    await reply(ctx, `❌ ${result.error}`);
    return;
  }
  const parts = [
    result.committed > 0 ? `提交了 ${result.committed} 个文件` : '本地没有新改动',
    result.pulled ? '已拉取远端' : '',
    result.pushed ? '已推送' : '',
  ].filter(Boolean);
  await reply(ctx, `🔄 ${parts.join('，')}。${result.note ?? ''}`.trim());
}

// ─── /cron ────────────────────────────────────────────────────────────────
