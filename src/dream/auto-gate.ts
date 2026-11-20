import { mkdir } from 'node:fs/promises';
import { log } from '../core/logger';
import { join } from 'node:path';
import { fullestQuotaWindow, quotaResetAt, readAgentQuota, type AccountLineCap, type QuotaReading } from '../agent/quota';
import type { ProfileConfig } from '../config/profile-schema';
import { getDreamAuto, type AppConfig, type DreamAutoSettings } from '../config/schema';
import type { KnowledgeStore } from '../knowledge/store';
import { knowledgeRemoteUrl } from '../knowledge/sync';
import { formatDreamRun } from './format';
import { countOpenDreamPullRequests } from './publish';
import {
  cheapDreamGate,
  dreamWindowAt,
  localTimeToday,
  materialGate,
  type DreamAutoCheck,
  type DreamMaterial,
} from './schedule';
import { measureNewInput } from './select';
import { nextDrainRound } from './drain';
import type { DreamRun, DreamSessionRecord, DreamStateStore } from './state';
import type { AgentTranscript } from '../agent/session-transcript';
import { baseRepo } from './util';

/**
 * 自动整理's gates: the cheap ones (window, ledger), then idleness, remote,
 * material, 待审积压 and quota; the last one standing starts a run. The
 * DreamService methods of the same names forward here.
 */

const UNKNOWN_QUOTA_BUDGET = 0.5;

/** The slice of the service's deps the gates read. */
export interface AutoGateDeps {
  workDir: string;
  knowledge: KnowledgeStore;
  appConfig: () => AppConfig;
  profileConfig: () => ProfileConfig;
  isProfileBusy?: () => boolean;
  isCapacityTight?: () => boolean;
  profileDir?: string;
  readQuota?: () => Promise<QuotaReading | undefined>;
  countOpenPrs?: (url: string) => Promise<number | undefined>;
}

/** What the gates need from the running service. */
export interface AutoGateHost {
  readonly deps: AutoGateDeps;
  readonly state: DreamStateStore;
  now(): number;
  enabled(): boolean;
  /** A run is in flight or being started. */
  runInFlight(): boolean;
  setLastCheck(check: DreamAutoCheck): void;
  repoTargets(knowledgeUrl: string | undefined): Array<{ repo: string; url: string }>;
  /** The read-only policy 自动整理预检 needs holds for the current agent. */
  readOnlyAllowed(): boolean;
  noteCatalog(): void;
  reader(): (record: DreamSessionRecord) => Promise<AgentTranscript | undefined>;
  tell(chatId: string | undefined, text: string): void;
  afterAutoChain(reason: string): void;
  /** Start the automatic run. */
  startAuto(
    onFinish: ((run: DreamRun) => void) | undefined,
    options: { trigger: 'auto'; budget: number; note?: string; round?: number; accountLineCap?: AccountLineCap },
  ): Promise<{ run: DreamRun } | { error: string; code?: 'off' | 'running' | 'no-remote' | 'locked' }>;
}

export type QuotaView = { percent: number; label: string; resets?: string } | { unknown: true };

/**
 * 自动整理's ceiling as a per-window cap: the weekly window only, or both
 * when `quotaWindow` is `any`.
 */
export function autoLineCap(auto: { maxQuotaPercent: number; quotaWindow: 'any' | 'week' }): AccountLineCap {
  return auto.quotaWindow === 'week'
    ? { seven_day: auto.maxQuotaPercent }
    : { five_hour: auto.maxQuotaPercent, seven_day: auto.maxQuotaPercent };
}

export async function runAutoCheck(host: AutoGateHost): Promise<DreamAutoCheck> {
  const { deps, state } = host;
  const now = host.now();
  const settings = getDreamAuto(deps.appConfig());
  if (!settings) {
    return noteCheck(host, { at: now, block: 'off', reason: host.enabled() ? '自动整理没有打开' : '课堂精练没有打开' });
  }
  const auto = settings.auto;
  if (host.runInFlight()) return noteCheck(host, { at: now, block: 'running', reason: '已经有一轮整理在进行' });
  const cheap = cheapDreamGate({ now, auto, ledger: state.autoLedger() });
  // 续跑: the last run left work behind (its chain was cut short by a user
  // task, a restart or the quota) — finish it once the profile is idle,
  // inside the window or not.
  const resume =
    cheap && (cheap.block === 'window-used' || cheap.block === 'outside-window')
      ? pendingDrain(host, settings.drainRounds)
      : undefined;
  if (cheap && !resume) return noteCheck(host, { at: now, ...cheap });
  const held = holdBack(deps);
  if (held.block) return noteCheck(host, { at: now, block: 'busy', reason: held.reason });
  const lastActive = state.sessions().reduce((latest, record) => Math.max(latest, record.lastSeenAt), 0);
  // Going by the pool, a conversation still going on is skipped on its own (仍在进行); the rest need not wait for it.
  if (!deps.isCapacityTight && now - lastActive < settings.minIdleMinutes * 60_000) {
    return noteCheck(host, {
      at: now,
      block: 'recent-activity',
      reason: `最近 ${settings.minIdleMinutes} 分钟内有对话，等空闲后再看`,
    });
  }
  const url = await knowledgeRemoteUrl(deps.knowledge).catch(log.swallow('dream', 'knowledge-remote-url-failed'));
  if (!url) return noteCheck(host, { at: now, block: 'no-remote', reason: '知识库没有绑定远端（/knowledge bind）' });
  if (!host.readOnlyAllowed()) {
    return noteCheck(host, { at: now, block: 'restricted', reason: '当前 agent 配置无法保证只读执行，不开放自动整理' });
  }
  host.noteCatalog();
  // 每日模式 runs whatever piled up — 课前学习 and own skills count as much as conversations.
  let material: DreamMaterial | undefined;
  if (!auto.daily && !resume) {
    const measured = await measureNewInput({ records: state.sessions(), settings, read: host.reader() });
    const counted = { scopes: measured.scopes, sessions: measured.sessions, chars: measured.chars };
    const gate = materialGate({ now, auto, material: counted, since: state.autoLedger().lastCompletedAt ?? measured.oldestAt });
    if (!gate.ok) return noteCheck(host, { at: now, block: 'material', reason: gate.reason, material: counted });
    material = gate.material;
  }
  // Pushed straight to the default branch, nothing waits for review.
  const openPrs = settings.publish === 'push' ? 0 : await openDreamPrs(host, url);
  if (openPrs >= auto.maxOpenPrs) {
    return noteCheck(host, {
      at: now,
      block: 'backlog',
      reason: `待审积压：还有 ${openPrs} 个课堂精练 Draft PR 没合并或关闭（上限 ${auto.maxOpenPrs}），暂停自动整理`,
      ...(material ? { material } : {}),
      openPrs,
    });
  }
  const { quota, lead: quotaLead, block: quotaBlock } = await quotaGate(deps, auto, now);
  const context = { ...(material ? { material } : {}), openPrs, quota };
  if (quotaBlock && resume) return noteCheck(host, { at: now, block: 'quota', reason: `续跑暂停：${quotaBlock}`, ...context });
  const lead = resume ? resume.note : quotaLead;
  if (quotaBlock) {
    const reason = quotaBlock;
    if (auto.daily) {
      // The weekly window will not empty within the hours left: today is skipped, once, and said so.
      state.updateAuto({ lastWindowKey: dreamWindowAt(now, auto.window, auto.timezone).key });
      host.tell(settings.notifyChat, `**📚 今天的课堂精练跳过**\n\n${reason}，明天 ${auto.daily.text} 再看。`);
      host.afterAutoChain('今天的课堂精练跳过');
    }
    return noteCheck(host, { at: now, block: 'quota', reason, ...context });
  }
  // The checks above took a while: a user may have shown up meanwhile.
  const heldLate = holdBack(deps);
  if (heldLate.block) return noteCheck(host, { at: now, block: 'busy', reason: heldLate.reason, ...context });
  const notifyChat = settings.notifyChat;
  const started = await host.startAuto(notifyChat ? (run) => host.tell(notifyChat, formatDreamRun(run)) : undefined, {
    trigger: 'auto',
    budget: 'unknown' in quota ? UNKNOWN_QUOTA_BUDGET : 1,
    ...(lead ? { note: lead } : {}),
    ...(resume ? { round: resume.round } : {}),
    // Over the limit but the window resets before quotaResetBefore: what is
    // left would go unused anyway, so no account is held back either.
    ...(quotaLead ? {} : { accountLineCap: autoLineCap(auto) }),
  });
  if ('error' in started) {
    return noteCheck(host, { at: now, block: started.code === 'locked' ? 'locked' : 'running', reason: started.error, ...context });
  }
  // A 续跑 outside the window must not use up the next one.
  if (!resume) state.updateAuto({ lastWindowKey: dreamWindowAt(now, auto.window, auto.timezone).key });
  return noteCheck(host, { at: now, started: started.run.id, ...context });
}

/**
 * 额度: over `maxQuotaPercent` blocks, unless the window resets today before
 * `quotaResetBefore` — whatever is left would go away at the reset anyway.
 */
export async function quotaGate(
  deps: AutoGateDeps,
  auto: DreamAutoSettings,
  now: number,
): Promise<{ quota: QuotaView; lead?: string; block?: string }> {
  const quota = await readQuota(deps, auto.quotaWindow);
  if (!('percent' in quota) || quota.percent < auto.maxQuotaPercent) return { quota };
  const resetAt = quotaResetAt(quota.resets, now);
  const before = auto.quotaResetBefore;
  if (resetAt !== undefined && before && resetAt > now && resetAt <= localTimeToday(now, before.at, auto.timezone)) {
    return { quota, lead: `${quota.label}额度已用 ${quota.percent}%，但今天 ${before.text} 前就重置，照常整理` };
  }
  return { quota, block: `额度已用 ${quota.percent}%（${quota.label}），到了 ${auto.maxQuotaPercent}% 的上限` };
}

/**
 * The 续跑 the latest run calls for, if any. Runs cut off before their
 * checkpoint by a user task, a restart or a shutdown consumed nothing: the
 * one before them still says what is left. A run cancelled by hand ends it.
 */
export function pendingDrain(host: AutoGateHost, maxRounds: number): { round: number; note: string } | undefined {
  const runs = host.state.runs();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    const interrupted =
      run.checkpointAt === undefined &&
      (run.yielded === true ||
        (run.status === 'cancelled' && !(run.note ?? '').startsWith('已取消')) ||
        (run.status === 'failed' && (run.note ?? '').startsWith('进程重启时中断')));
    if (!interrupted) return nextDrainRound(run, maxRounds);
  }
  return undefined;
}

/** Automatic runs must hold back: slots are short, or (without a pool to go by) anything else runs. */
export function holdBack(deps: AutoGateDeps): { block: boolean; reason: string } {
  if (deps.isCapacityTight) {
    return { block: deps.isCapacityTight(), reason: '进程池已满、有用户任务在等位，用户任务优先' };
  }
  return { block: deps.isProfileBusy?.() ?? false, reason: '有任务在跑或有消息在排队，用户任务优先' };
}

/** Keep the latest check; the stored one is rewritten only when the outcome changes. */
export function noteCheck(host: AutoGateHost, check: DreamAutoCheck): DreamAutoCheck {
  host.setLastCheck(check);
  // A switched-off or busy-running profile gets no state file writes for it.
  if (check.block === 'off' || check.block === 'running') return check;
  const stored = host.state.autoLedger().lastCheck;
  if (check.started || !stored || stored.block !== check.block || stored.reason !== check.reason) {
    host.state.updateAuto({ lastCheck: check });
  }
  return check;
}

export async function openDreamPrs(host: AutoGateHost, knowledgeUrl: string): Promise<number> {
  const { deps } = host;
  const count = deps.countOpenPrs ?? ((url: string) => countOpenDreamPullRequests(deps.workDir, url));
  const runs = host.state.runs();
  let worst = 0;
  for (const repo of host.repoTargets(knowledgeUrl)) {
    const live = await count(repo.url).catch(log.swallow('dream', 'count-open-prs-failed'));
    // Drafts of ours still waiting to be pushed / opened are part of the
    // backlog too — and all there is to go on when `gh` cannot answer.
    const waiting = runs
      .flatMap((run) => run.targets)
      .filter((target) => baseRepo(target.repo) === repo.repo && (target.phase === 'committed' || target.phase === 'pushed')).length;
    worst = Math.max(worst, (live ?? 0) + waiting);
  }
  return worst;
}

export async function readQuota(deps: AutoGateDeps, window: 'any' | 'week' = 'any'): Promise<QuotaView> {
  const read =
    deps.readQuota ??
    (async () => {
      const cwd = join(deps.workDir, 'scratch');
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      return readAgentQuota(deps.profileConfig(), {
        cwd,
        ...(deps.profileDir ? { profileDir: deps.profileDir } : {}),
        window,
      });
    });
  const reading = await read().catch(log.swallow('dream', 'quota-read-failed'));
  const chosen = !reading
    ? undefined
    : window === 'week' && !reading.blocked
      ? reading.windows.find((item) => item.label === '本周')
      : fullestQuotaWindow(reading);
  return chosen
    ? { percent: Math.round(chosen.usedPercent), label: chosen.label, ...(chosen.resets ? { resets: chosen.resets } : {}) }
    : { unknown: true };
}
