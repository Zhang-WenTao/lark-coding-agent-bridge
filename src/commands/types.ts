// The command layer's shapes, apart from its 4,000 lines of handlers, so the
// many modules that only pass `Controls` around import types, not handlers.
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { ModelPinStore } from '../agent/model-pin';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { AutoResumer } from '../bot/auto-resume';
import type { KnownChat } from '../bot/lark-info';
import type { ProcessPool } from '../bot/process-pool';
import type { RunsMonitor } from '../bot/runs-monitor';
import type { CodeSnippetStore } from '../card/code-snippets';
import type { ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import type { DreamService } from '../dream/service';
import type { KnowledgeAutoSync } from '../knowledge/auto-sync';
import type { SkillLibraries } from '../knowledge/libraries';
import type { KnowledgeStore } from '../knowledge/store';
import type { MeetingManager } from '../meeting/manager';
import type { OwnerRefreshState } from '../policy/access';
import type { ApprovalBroker } from '../runtime/approvals';
import type { AuditLog } from '../runtime/audit-log';
import type { RunExecutor } from '../runtime/run-executor';
import type { UsageLedger } from '../runtime/usage-ledger';
import type { Scheduler } from '../scheduler/scheduler';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import type { CodexThreadHistoryEntry, ListCodexThreadHistoryOptions } from '../session/codex-history';
import type { SessionSummary } from '../session/history';
import type { PendingRotationStore } from '../session/rotation-store';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface Controls {
  profile: string;
  profileConfig: ProfileConfig;
  botOwnerId?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
  refreshOwner(channel?: LarkChannel): Promise<void>;
  /** Restart the bridge in-process: disconnect WS, kill claude runs, reload
   * config, reconnect with the new credentials. */
  restart(opts?: { wait?: boolean }): Promise<void>;
  /** Stop this whole process gracefully (disconnect + exit). Used by /exit
   * when the user targets the receiving process itself. */
  exit(): Promise<void>;
  /** Path to the config file the bridge was started with. */
  configPath: string;
  /** The current app config (snapshot at startChannel time). */
  cfg: AppConfig;
  /** This process's short id in the registry. Used by /ps to highlight the
   * receiving process and by /exit to detect self-target. */
  processId: string;
  /** Groups the bot currently belongs to, used to render and bulk-manage access. */
  knownChats?: KnownChat[];
  /** In-meeting agent manager; present only while the channel is connected and
   * `meeting.enabled` is on. Late-bound by startChannel. */
  meeting?: MeetingManager;
  /** Live-run view + interrupt for the web console's tasks panel; present only
   * while the channel is connected. Late-bound by startChannel. */
  runsMonitor?: RunsMonitor;
  /** Cross-session memory + skills for this profile, backing `/memory`,
   * `/skills` and `/knowledge`. Late-bound by startChannel. */
  knowledge?: KnowledgeStore;
  /** Shared skill libraries backing `/skills lib`. Late-bound by startChannel. */
  skillLibraries?: SkillLibraries;
  /** Periodic sync of the knowledge repo, shown by `/knowledge`. Late-bound by startChannel. */
  knowledgeAutoSync?: KnowledgeAutoSync;
  /** Scheduled-job engine backing `/cron`; present only while the channel is
   * connected and a profile data dir exists. Late-bound by startChannel. */
  scheduler?: Scheduler;
  /** Late-bound like `scheduler`: quota-paused tasks waiting to resume. */
  autoResumer?: AutoResumer;
  /** Per-person consumption backing `/usage`; present only while the channel
   * is connected and a profile data dir exists. Late-bound by startChannel. */
  usage?: UsageLedger;
  /** Pending approvals for runs non-admins drive (`approval.*` card buttons). Late-bound by startChannel. */
  approvals?: ApprovalBroker;
  /** Who had the bot do what, backing `/audit`. Late-bound by startChannel. */
  audit?: AuditLog;
  /** 会话智能压缩 closes the agent asked for, read by `/status`. Late-bound by startChannel. */
  pendingRotations?: Pick<PendingRotationStore, 'get'>;
  /** Code blocks behind finished cards' 「复制代码」 buttons (see /copycode). */
  codeSnippets?: Pick<CodeSnippetStore, 'get' | 'put'>;
  /** 指定模型: each topic's `/model` pin. Late-bound by startChannel. */
  modelPins?: ModelPinStore;
  /** 课堂精练 backing `/practice` and the console's dream panel. Late-bound by startChannel. */
  dream?: DreamService;
}

export interface CommandContext {
  channel: LarkChannel;
  msg: NormalizedMessage;
  /**
   * Session scope string. For p2p / regular group it equals `msg.chatId`;
   * for topic groups it's `${chatId}:${threadId}` (so each topic gets its
   * own session / cwd / active-run). All handlers should read/write
   * session / workspace / activeRuns through this — never through
   * `msg.chatId` directly.
   */
  scope: string;
  /** Resolved chat mode for `msg.chatId`. Used by /status to surface the
   * scope semantic to the user (`topic` shows "话题独立 session"). */
  chatMode: 'p2p' | 'group' | 'topic';
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  sessionCatalogIdentity?: SessionCatalogIdentity;
  workspaces: WorkspaceStore;
  agent: AgentAdapter;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  /** Quota-paused tasks waiting to resume; `/stop` cancels, `/status` shows. */
  autoResumer?: AutoResumer;
  codexHistoryProvider?: (
    options: ListCodexThreadHistoryOptions,
  ) => Promise<CodexThreadHistoryEntry[]>;
  claudeHistoryProvider?: (cwd: string, limit: number) => Promise<SessionSummary[]>;
  /** Set when invoked from a CardKit 2.0 form submit. Keys are input `name`s. */
  formValue?: Record<string, unknown>;
  /** True when this invocation came from a card button click rather than a
   * text command. Determines whether to update the existing card vs send a
   * new one. */
  fromCardAction?: boolean;
}
