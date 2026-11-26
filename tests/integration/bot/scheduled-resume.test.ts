import type { NormalizedMessage } from '@larksuite/channel';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { AutoResumer } from '../../../src/bot/auto-resume.js';
import { SCHEDULED_RESUME_GRACE_MS } from '../../../src/bot/scheduled-resume.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

/**
 * 按约定暂停: the agent ends an owner run with a `[[RESUME_…]]` line and the
 * bridge picks the task up again at the agreed time — in the same chat,
 * conversation and session, from the task ledger — across a restart too,
 * unless `/stop` or `[[RESUME_CANCEL]]` drops it.
 */

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

// What `/usage` says when a scheduled resume checks the self-pause line; never spawns a CLI.
const quotaMock = vi.hoisted(() => ({
  reading: undefined as import('../../../src/agent/quota.js').QuotaReading | undefined,
  calls: 0,
}));

vi.mock('../../../src/agent/quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/quota.js')>();
  return {
    ...actual,
    readAgentQuota: async () => {
      quotaMock.calls++;
      return quotaMock.reading;
    },
  };
});

import { startChannel } from '../../../src/bot/channel.js';

type Mode = 'card' | 'markdown' | 'text' | 'final-card' | 'cot';

interface StreamCall {
  kind: 'card' | 'markdown';
  options: unknown;
  renders: string[];
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  streams: StreamCall[];
  reactions: Array<{ messageId: string; emoji: string }>;
  rawClient: Record<string, unknown>;
  on(handlers: FakeLarkChannel['handlers']): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  updateCard: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const OWNER = 'ou_owner';
const GUEST = 'ou_guest';
const LEDGER = '/tmp/scheduled-resume-ledger.md';
const MIN = 60_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  quotaMock.reading = undefined;
  quotaMock.calls = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A Claude-style owner run: work, the ledger line, a tool call, then the pause with its marker. */
function pausingRun(marker: string, sessionId = 'sess-1'): AgentEvent[] {
  return [
    { type: 'system', sessionId },
    { type: 'text', delta: `第一阶段完成。\n📒 任务台账：${LEDGER}` },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log -1' } },
    { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    { type: 'text', delta: `5 小时额度已过半，按你的要求先停，重置后接着做。\n${marker}` },
    { type: 'done', terminationReason: 'normal' },
  ];
}

function answer(text: string, sessionId = 'sess-1'): AgentEvent[] {
  return [
    { type: 'system', sessionId },
    { type: 'text', delta: text },
    { type: 'done', terminationReason: 'normal' },
  ];
}

describe('a task the agent pauses with [[RESUME_AFTER: five_hour]]', () => {
  it('goes on by itself 1–2 minutes after the 5-hour reset, in the same chat and session, from the ledger', async () => {
    const reset = Date.now() + 40 * MIN;
    const profile = await createProfile({ fiveHourReset: reset });
    const h = await startBridge(profile, {
      events: [pausingRun('[[RESUME_AFTER: five_hour]]'), answer('CONTINUED_FROM_LEDGER')],
    });

    await h.channel.handlers.message?.(message('om_task', '升级依赖，5 小时额度超过 50% 就停，重置后再做', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') !== undefined);

    // The owner's run was told about the markers.
    expect(h.agent.runOptions[0]?.prompt).toContain('[[RESUME_AFTER: five_hour');
    // The card says when it goes on, and never shows the marker.
    const card = h.channel.streams[0]!.renders.at(-1)!;
    expect(card).toContain('自动继续');
    expect(card).toContain('按任务台账接着做');
    expect(card).not.toContain('[[RESUME');

    const resume = h.autoResumer().get('oc_dm')!;
    expect(resume).toMatchObject({
      kind: 'scheduled',
      ledger: LEDGER,
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: OWNER,
      originMessageId: 'om_task',
      attempt: 1,
    });
    expect(resume.resumeAt).toBe(reset + SCHEDULED_RESUME_GRACE_MS);
    expect(resume.resumeAt - reset).toBeGreaterThanOrEqual(MIN);
    expect(resume.resumeAt - reset).toBeLessThanOrEqual(2 * MIN);

    // Nothing at the reset itself…
    await h.autoResumer().tick(reset);
    await sleep(100);
    expect(h.agent.runOptions).toHaveLength(1);

    // …and once due, a new turn in the same session, under the same question.
    await h.autoResumer().tick(resume.resumeAt);
    await waitFor(() => (h.channel.streams[1]?.renders.at(-1) ?? '').includes('CONTINUED_FROM_LEDGER'));
    const resumed = h.agent.runOptions[1]!;
    expect(resumed.prompt).toContain('[自动继续]');
    expect(resumed.prompt).toContain(LEDGER);
    expect(resumed.sessionId).toBe('sess-1');
    expect(h.channel.streams[1]!.options).toEqual({ replyTo: 'om_task' });
    await waitFor(() => h.autoResumer().get('oc_dm') === undefined);
  });

  it('is cancelled by the owner\'s /stop', async () => {
    const profile = await createProfile({ fiveHourReset: Date.now() + 40 * MIN });
    const h = await startBridge(profile, { events: [pausingRun('[[RESUME_AFTER: five_hour]]')] });

    await h.channel.handlers.message?.(message('om_task', '升级依赖', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') !== undefined);
    const resume = h.autoResumer().get('oc_dm')!;

    await h.channel.handlers.message?.(message('om_stop', '/stop', OWNER));
    await waitFor(() => JSON.stringify(h.channel.sent).includes('已取消自动续跑'));
    expect(h.autoResumer().get('oc_dm')).toBeUndefined();

    await h.autoResumer().tick(resume.resumeAt + MIN);
    await sleep(800);
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('still fires on time after a bridge restart', async () => {
    const reset = Date.now() + 40 * MIN;
    const profile = await createProfile({ fiveHourReset: reset });
    const before = await startBridge(profile, { events: [pausingRun('[[RESUME_AFTER: five_hour]]')] });
    await before.channel.handlers.message?.(message('om_task', '升级依赖', OWNER));
    await waitFor(() => before.autoResumer().get('oc_dm') !== undefined);
    await before.disconnect();

    const onDisk = JSON.parse(await readFile(profile.autoResumeFile, 'utf8')).resumes.oc_dm;
    expect(onDisk).toMatchObject({ kind: 'scheduled', ledger: LEDGER, resumeAt: reset + SCHEDULED_RESUME_GRACE_MS });

    const after = await startBridge(profile, { events: [answer('PICKED_UP_AFTER_RESTART')] });
    const resume = after.autoResumer().get('oc_dm');
    expect(resume).toMatchObject({ kind: 'scheduled', ledger: LEDGER });
    await after.autoResumer().tick(resume!.resumeAt - 1);
    await sleep(100);
    expect(after.agent.runOptions).toHaveLength(0);
    await after.autoResumer().tick(resume!.resumeAt);
    await waitFor(() => (after.channel.streams[0]?.renders.at(-1) ?? '').includes('PICKED_UP_AFTER_RESTART'));
    expect(after.agent.runOptions[0]?.prompt).toContain(LEDGER);
    expect(after.agent.runOptions[0]?.sessionId).toBe('sess-1');
  });
});

describe('between the pause and the resume', () => {
  it('keeps the resume through an unrelated owner message, and drops it on [[RESUME_CANCEL]]', async () => {
    const at = futureClock(3 * 60 * MIN);
    const profile = await createProfile();
    const h = await startBridge(profile, {
      events: [
        pausingRun(`[[RESUME_AT: ${at.text} | ${LEDGER}]]`),
        answer('今天天气不错。'),
        answer('好的，先不做了。\n[[RESUME_CANCEL]]'),
      ],
    });

    await h.channel.handlers.message?.(message('om_task', '升级依赖，晚点再继续', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') !== undefined);
    expect(h.autoResumer().get('oc_dm')).toMatchObject({ kind: 'scheduled', resumeAt: at.ms, ledger: LEDGER });

    // An unrelated question in between: answered, and the plan stands.
    await h.channel.handlers.message?.(message('om_chat', '今天天气怎么样', OWNER));
    await waitFor(() => (h.channel.streams[1]?.renders.at(-1) ?? '').includes('天气不错'));
    await sleep(100);
    expect(h.autoResumer().get('oc_dm')).toMatchObject({ kind: 'scheduled', resumeAt: at.ms });
    // That run knew about the pending resume, so it could cancel it.
    expect(h.agent.runOptions[1]?.prompt).toContain('当前已约定');

    // The owner changes their mind; the agent cancels.
    await h.channel.handlers.message?.(message('om_cancel', '那个升级先别做了', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') === undefined);
    const card = h.channel.streams[2]!.renders.at(-1)!;
    expect(card).toContain('已取消原定');
    expect(card).not.toContain('[[RESUME');
  });
});

describe('with a self-pause line (preferences.selfPause)', () => {
  it('reads the quota when due and, past the line, waits for the reset without starting the agent', async () => {
    const at = futureClock(60 * MIN);
    const profile = await createProfile();
    const h = await startBridge(profile, {
      preferences: { selfPause: { fiveHourPercent: 50 } },
      events: [pausingRun(`[[RESUME_AT: ${at.text}]]`), answer('WENT_ON_AFTER_RESET')],
    });
    await h.channel.handlers.message?.(message('om_task', '额度过半就停', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') !== undefined);
    expect(quotaMock.calls).toBe(0);

    // Due, but the 5-hour window is at 63%: postponed to its reset, and the chat is told why.
    const reset = at.ms + 90 * MIN;
    quotaMock.reading = { windows: [{ label: '5 小时窗口', usedPercent: 63, resets: new Date(reset).toISOString() }] };
    await h.autoResumer().tick(at.ms);
    await waitFor(() => JSON.stringify(h.channel.sent).includes('自停线'));
    expect(quotaMock.calls).toBe(1);
    expect(h.agent.runOptions).toHaveLength(1);
    const postponed = h.autoResumer().get('oc_dm');
    expect(postponed).toMatchObject({ kind: 'scheduled', resumeAt: reset + SCHEDULED_RESUME_GRACE_MS, attempt: 1 });
    expect(JSON.parse(await readFile(profile.autoResumeFile, 'utf8')).resumes.oc_dm.resumeAt).toBe(reset + SCHEDULED_RESUME_GRACE_MS);

    // After the reset the window is fresh: the task goes on.
    quotaMock.reading = { windows: [{ label: '5 小时窗口', usedPercent: 0 }] };
    await h.autoResumer().tick(postponed!.resumeAt);
    await waitFor(() => (h.channel.streams[1]?.renders.at(-1) ?? '').includes('WENT_ON_AFTER_RESET'));
    expect(h.agent.runOptions[1]?.prompt).toContain('[自动继续]');
  });

  it('goes on when the quota cannot be read', async () => {
    const at = futureClock(60 * MIN);
    const profile = await createProfile();
    const h = await startBridge(profile, {
      preferences: { selfPause: { fiveHourPercent: 50 } },
      events: [pausingRun(`[[RESUME_AT: ${at.text}]]`), answer('WENT_ON_UNREAD')],
    });
    await h.channel.handlers.message?.(message('om_task', '额度过半就停', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') !== undefined);
    await h.autoResumer().tick(at.ms);
    await waitFor(() => (h.channel.streams[1]?.renders.at(-1) ?? '').includes('WENT_ON_UNREAD'));
    expect(quotaMock.calls).toBe(1);
  });
});

describe('gates', () => {
  it("never schedules from someone else's run, and still hides the marker", async () => {
    const profile = await createProfile({ fiveHourReset: Date.now() + 40 * MIN });
    const h = await startBridge(profile, { events: [pausingRun('[[RESUME_AFTER: five_hour]]')] });

    await h.channel.handlers.message?.(message('om_guest', '帮我跑个长任务', GUEST));
    await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
    await sleep(100);
    expect(h.autoResumer().get('oc_dm')).toBeUndefined();
    expect(h.agent.runOptions[0]?.prompt).not.toContain('[[RESUME_AFTER');
    const card = h.channel.streams[0]!.renders.at(-1)!;
    expect(card).toContain('只有主人发起的任务');
    expect(card).not.toContain('[[RESUME');
  });

  it('refuses a time more than 24 hours out, and says so on the reply', async () => {
    const profile = await createProfile();
    const far = futureClock(30 * 60 * MIN);
    const h = await startBridge(profile, { events: [pausingRun(`[[RESUME_AT: ${far.text}]]`)] });

    await h.channel.handlers.message?.(message('om_task', '升级依赖', OWNER));
    await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
    await sleep(100);
    expect(h.autoResumer().get('oc_dm')).toBeUndefined();
    expect(h.channel.streams[0]!.renders.at(-1)).toContain('24 小时');
  });
});

describe.each(['markdown', 'text', 'final-card', 'cot'] as const)('in %s mode', (mode) => {
  it('strips the marker from what the user sees and notes the resume time', async () => {
    const profile = await createProfile({ fiveHourReset: Date.now() + 40 * MIN });
    const h = await startBridge(profile, { mode, events: [pausingRun('[[RESUME_AFTER: five_hour]]')] });

    await h.channel.handlers.message?.(message('om_task', '升级依赖', OWNER));
    await waitFor(() => h.autoResumer().get('oc_dm') !== undefined);
    await waitFor(() => h.channel.reactions.some((r) => r.emoji === 'DONE'));
    await sleep(100);
    const shown = [
      ...h.channel.sent.map((s) => JSON.stringify(s.content)),
      ...h.channel.streams.map((s) => s.renders.at(-1) ?? ''),
    ].join('\n');
    expect(shown).toContain('自动继续');
    expect(shown).not.toContain('[[RESUME');
    expect(h.cotRequests.join('\n')).not.toContain('[[RESUME');
  });
});

interface Profile {
  tmp: TmpProfile;
  workspace: string;
  autoResumeFile: string;
  appPaths: NonNullable<Parameters<typeof startChannel>[0]['appPaths']>;
}

/** A profile directory, with what the last Claude run reported about its 5-hour window. */
async function createProfile(opts: { fiveHourReset?: number } = {}): Promise<Profile> {
  const tmp = await createTmpProfile('scheduled-resume-');
  cleanups.push(() => tmp.cleanup());
  if (opts.fiveHourReset !== undefined) {
    await writeFile(
      join(tmp.profile, 'claude-accounts-state.json'),
      JSON.stringify({
        accounts: { default: { windows: { five_hour: { usedPercent: 52, resetsAt: opts.fiveHourReset } }, updatedAt: Date.now() } },
      }),
    );
  }
  const autoResumeFile = join(tmp.profile, 'auto-resume.json');
  return {
    tmp,
    workspace: await realpath(tmp.workspace),
    autoResumeFile,
    appPaths: {
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, 'keystore.salt'),
      mediaDir: join(tmp.profile, 'media'),
      runsFile: join(tmp.profile, 'runs.json'),
      knowledgeDir: join(tmp.profile, 'knowledge'),
      jobsFile: join(tmp.profile, 'jobs.json'),
      pendingFile: join(tmp.profile, 'pending.json'),
      usageFile: join(tmp.profile, 'usage.json'),
      auditFile: join(tmp.profile, 'audit.jsonl'),
      profileDir: tmp.profile,
      autoResumeFile,
    },
  };
}

async function startBridge(
  profile: Profile,
  opts: { events: FakeAgentEvents; mode?: Mode; preferences?: Record<string, unknown> },
) {
  const mode = opts.mode ?? 'card';
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [GUEST] },
    preferences: {
      messageReply: mode === 'cot' ? 'markdown' : mode,
      messageReplyMigrated: true,
      ...(mode === 'cot' ? { cotMessages: 'brief' as const } : {}),
      ...opts.preferences,
    },
  });
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: profile.workspace } };
  // As the daemon does at startup: a restarted bridge reads back the scope's session.
  const sessions = new SessionStore(join(profile.tmp.profile, 'sessions.json'));
  await sessions.load();
  const workspaces = new WorkspaceStore(join(profile.tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ events: opts.events });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;

  // CoT talks to Feishu over plain fetch, not through the SDK channel.
  const cotRequests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('tenant_access_token')) return jsonResponse({ code: 0, tenant_access_token: 't', expire: 7200 });
    cotRequests.push(typeof init?.body === 'string' ? init.body : '');
    if (url.includes('message_cot?receive_id_type=chat_id')) {
      return jsonResponse({ code: 0, data: { cot_id: 'cot_1', message_id: 'om_cot' } });
    }
    return jsonResponse({ code: 0, data: {} });
  }));

  const controls = {
    profile: 'test',
    profileConfig,
    botOwnerId: OWNER,
    ownerRefreshState: 'ok' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
    autoResumer: undefined as AutoResumer | undefined,
  };
  const bridge = await startChannel({ cfg: profileConfig, agent, sessions, workspaces, controls, appPaths: profile.appPaths });
  let open = true;
  const disconnect = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
  };
  cleanups.push(disconnect);
  return {
    channel,
    agent,
    cotRequests,
    disconnect,
    autoResumer: (): AutoResumer => {
      if (!controls.autoResumer) throw new Error('bridge not started');
      return controls.autoResumer;
    },
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: FakeLarkChannel['handlers'] = {};
  const sent: FakeLarkChannel['sent'] = [];
  const streams: StreamCall[] = [];
  const reactions: FakeLarkChannel['reactions'] = [];
  let nextReaction = 1;
  return {
    handlers,
    sent,
    streams,
    reactions,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: OWNER } } } })) } },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
            list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
          },
        },
      },
    },
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'p2p';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(_chatId, input, options) {
      const messageId = `om_stream_${streams.length + 1}`;
      const card = (input as { card?: { producer(ctrl: object): Promise<void> } }).card;
      const markdown = (input as { markdown?: (ctrl: object) => Promise<void> }).markdown;
      const call: StreamCall = { kind: card ? 'card' : 'markdown', options, renders: [] };
      streams.push(call);
      if (card) {
        await card.producer({
          messageId,
          async update(next: unknown) {
            call.renders.push(JSON.stringify(next));
          },
        });
      } else if (markdown) {
        await markdown({
          messageId,
          async setContent(body: string) {
            call.renders.push(body);
          },
        });
      }
      return { messageId };
    },
    updateCard: vi.fn(async () => {}),
    recallMessage: vi.fn(async () => {}),
    async addReaction(messageId, emojiType) {
      reactions.push({ messageId, emoji: emojiType });
      return `reaction_${nextReaction++}`;
    },
    async removeReaction() {},
  };
}

let createTime = 1760000001000;

function message(messageId: string, content: string, senderId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId,
    senderName: senderId === OWNER ? 'Owner' : 'Guest',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionedBot: false,
    createTime: createTime++,
  } as unknown as NormalizedMessage;
}

/** `offsetMs` from now on the host clock, as a marker writes it (whole minutes). */
function futureClock(offsetMs: number): { text: string; ms: number } {
  const d = new Date(Date.now() + offsetMs);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    text: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    ms: d.getTime(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for async work');
}
