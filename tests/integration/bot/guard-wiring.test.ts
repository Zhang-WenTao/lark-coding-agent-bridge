import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn((_opts: unknown) => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { RunRegistry } from '../../../src/runtime/run-registry.js';
import { resolveAppPaths } from '../../../src/config/app-paths.js';

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * What the channel hands the agent for each kind of sender
 * (docs/progress/bridge-refactor-analysis.md §5.3 #1): the owner runs
 * unfenced, anyone else gets the guest guard built from `access`, and a
 * restricted chat adds its own limits for everyone, the owner included.
 */
const RESTRICTED = 'oc_chat';
const restricted = {
  [RESTRICTED]: { deniedCommands: ['\\bkubectl\\b'], refusal: '这是一个危险操作，暂时不支持' },
};

async function runFor(access: Record<string, unknown>, senderId: string) {
  const h = await createHarness(access);
  await startTestBridge(h);
  await h.channel.handlers.message?.(
    message({ messageId: `om_${senderId}`, senderId, content: '@Bridge 查一下', rawSenderType: 'user' }),
  );
  await waitFor(() => h.agent.runOptions.length === 1);
  return h.agent.runOptions[0]!;
}

describe('guard wiring from channel to agent', () => {
  it('runs the owner without a guard or guest instructions', async () => {
    const opts = await runFor({ guestRoots: ['~/shared'] }, 'ou_owner');
    expect(opts.guard).toBeUndefined();
    expect(opts.prompt).not.toContain('~/shared');
  });

  it('fences a guest to the open roots and tells them where they may look', async () => {
    const opts = await runFor(
      { guestRoots: ['~/shared'], guestReadOnlyRoots: ['~/readonly'], guestDeniedCommands: ['\\bsecret-cmd\\b'] },
      'ou_user',
    );
    const guard = opts.guard!;
    expect(guard).toBeDefined();
    const home = guard.home;
    expect(home).toBe(homedir());
    const open = (guard.openDirs ?? []).map((d) => [d.path, Boolean(d.readOnly)]);
    expect(open).toEqual(expect.arrayContaining([[`${home}/shared`, false], [`${home}/readonly`, true]]));
    expect(guard.deniedCommands.map(String).join(' ')).toContain('secret-cmd');
    expect(opts.prompt).toContain('~/shared');
    expect(opts.prompt).toContain('~/readonly');
  });

  it('holds the owner to a restricted chat\'s own limits, without the guest fence', async () => {
    const opts = await runFor({ guestRoots: ['~/shared'], restrictedChats: restricted }, 'ou_owner');
    const guard = opts.guard!;
    expect(guard).toBeDefined();
    expect(guard.deniedCommands.map(String).join(' ')).toContain('kubectl');
    expect(guard.openDirs ?? []).toEqual([]);
    expect(opts.prompt).toContain('这是一个危险操作，暂时不支持');
  });

  it('gives a guest in a restricted chat both the guest fence and the chat limits', async () => {
    const opts = await runFor({ guestRoots: ['~/shared'], restrictedChats: restricted }, 'ou_user');
    const guard = opts.guard!;
    expect(guard.deniedCommands.map(String).join(' ')).toContain('kubectl');
    expect((guard.openDirs ?? []).map((d) => d.path)).toContain(`${guard.home}/shared`);
    expect(opts.prompt).toContain('这是一个危险操作，暂时不支持');
  });
});

async function createHarness(access: Record<string, unknown>): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('guard-wiring-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user', 'ou_owner'],
      ...access,
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'ok' as const,
    botOwnerId: 'ou_owner',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  content: string;
  senderId?: string;
  senderName?: string;
  rawSenderType?: string;
  mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: input.senderName ?? 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions ?? [
      { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
    ],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1760000001000,
    ...(input.rawSenderType
      ? {
          raw: {
            sender: {
              sender_id: { open_id: input.senderId ?? 'ou_user' },
              sender_type: input.rawSenderType,
            },
            message: { message_id: input.messageId },
          },
        }
      : {}),
  } as unknown as NormalizedMessage;
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

