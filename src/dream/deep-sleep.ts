import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import type { DreamSettings } from '../config/schema';
import { log } from '../core/logger';
import { DIGEST_MANIFEST, digestView, isDigestScope, parseManifest } from '../knowledge/digest';
import { sanitizeScopeId } from '../knowledge/store';
import type { KnowledgeStore } from '../knowledge/store';
import { knowledgeRemoteUrl } from '../knowledge/sync';
import { ARCHIVE_DAYS, archiveChangelogLines, archiveNotes, MAX_ARCHIVE, observeNotes } from './archive';
import {
  applyMemoryPlan,
  buildMemoryPrompt,
  memoryPlanSummary,
  memoryPrBody,
  memoryPrTitle,
  memoryWorthConsolidating,
  parseMemoryOps,
  readMemoryFiles,
  readPendingFlags,
} from './consolidate';
import { diaryEntry, diaryWorthWriting, writeDiary, type DiaryInput } from './diary';
import { runDigest } from './global-digest';
import { dreamBranch, prepareCheckout, pullRequestState, writeChangelog } from './publish';
import type { RecallStore } from './recall';
import { deepChangelogEntry } from './report';
import type { DreamStateStore, DreamTarget } from './state';

/** 深睡整理's direct target in the knowledge repository: diary, notes consolidation, archive. */
const DEEP_REPO = 'knowledge:deep';
/** 深睡·记忆整合: always a Draft PR of its own. */
const MEMORY_REPO = 'knowledge:memory';
/** Between two 记忆整合 PRs, so a rejected one is not proposed again the next night. */
const MEMORY_COOLDOWN_MS = 3 * 86_400_000;

/** Who a deep-sleep agent turn runs as. */
export interface DeepSleepActor {
  id: string;
  name?: string;
}

/** What 深睡 needs from the running service. */
export interface DeepSleepHost {
  readonly deps: {
    workDir: string;
    profile: string;
    knowledge: KnowledgeStore;
    profileConfig: () => ProfileConfig;
  };
  readonly state: DreamStateStore;
  readonly recall: RecallStore;
  now(): number;
  runAgent(
    scopeId: string,
    prompt: string,
    actor: DeepSleepActor,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ text: string } | { error: string }>;
  commitTarget(id: string, target: DreamTarget, files: string[], summary: string): Promise<DreamTarget>;
  pushAndOpen(id: string, target: DreamTarget): Promise<DreamTarget>;
  saveTarget(id: string, target: DreamTarget): DreamTarget;
}

/**
 * 深睡整理, once the night's input is checkpointed and published: 记忆整合
 * as a Draft PR of its own; then, straight onto the default branch, 笔记整合,
 * 归档 and the diary entry at the top of DREAMS.md. The diary is also kept with
 * the run. Nothing here moves a cursor; a failure is reported and looked at
 * again another night. Returns a line for the run's summary, if any.
 */
export async function deepSleep(
  host: DeepSleepHost,
  id: string,
  settings: DreamSettings,
  ctx: { actor: DeepSleepActor; deadline: number; signal: AbortSignal; yielding?: boolean; noteScopes: readonly string[] },
  diary: DiaryInput,
): Promise<string | undefined> {
  const { signal } = ctx;
  const url = await knowledgeRemoteUrl(host.deps.knowledge).catch(log.swallow('dream', 'knowledge-remote-url-failed'));
  const notes: string[] = [];
  const done = () => {
    host.state.updateRun(id, { diary: diaryEntry(diary) });
    return notes.join('；') || undefined;
  };
  // Agent turns only when the run has time left and nobody is waiting for a slot.
  const awake = settings.deepSleep && url && !signal.aborted && !ctx.yielding;
  if (awake) {
    const consolidation = await consolidateMemory(host, id, url, ctx);
    if (consolidation) {
      diary.deep.consolidation = consolidation;
      if (consolidation.error) notes.push(`记忆整合没做成：${consolidation.error}`);
      else if (consolidation.prUrl) notes.push(`记忆整合 Draft PR：${consolidation.prUrl}`);
    }
  }
  // With publish: pr the notes being merged are the ones tonight's unmerged PR
  // appends to, and a Draft PR for nothing but the diary is noise: the diary
  // stays in the run record.
  if (signal.aborted || settings.publish !== 'push' || !url) return done();
  const archivable = awake ? host.recall.archivable(ARCHIVE_DAYS, host.now(), diary.timezone, MAX_ARCHIVE) : [];
  if (!diaryWorthWriting(diary) && !awake && archivable.length === 0) return done();
  let target: DreamTarget = { repo: DEEP_REPO, label: '知识库（深睡整理）', branch: dreamBranch(id), phase: 'failed', items: 0, direct: true };
  const dir = join(host.deps.workDir, 'batches', id, 'deep');
  const prepared = await prepareCheckout({ repo: DEEP_REPO, label: target.label, url }, dir, target.branch, { direct: true });
  if ('error' in prepared) {
    host.saveTarget(id, { ...target, error: prepared.error });
    notes.push(`深睡整理没做成：${prepared.error}`);
    return done();
  }
  target = { ...target, branch: prepared.base, base: prepared.base, checkoutDir: dir };
  const files: string[] = [];
  const logLines: string[] = [];
  // 全局整合 replaces the per-chat merge: raw notes stay as written, the layer is rebuilt from what changed.
  if (awake) {
    const digested = await digestNotes(host, id, dir, ctx);
    if (digested) {
      diary.deep.notesMerge = digested.summary;
      files.push(...digested.files);
      logLines.push(...digested.lines);
      if (digested.summary.error) notes.push(`全局整合有部分没做成：${digested.summary.error}`);
    }
  }
  // 归档 after the merges (a merged note changed tonight, a folded one is
  // gone), and observed before it: should the push fail, the notes are
  // still known and come up again tomorrow.
  const now = host.now();
  host.recall.observeNotes(await observeNotes(dir), now);
  if (awake) {
    // The layer and the raw notes it was folded from stay: the layer is what gets read now, the raw notes are its sources.
    const digest = digestView(parseManifest(await readFile(join(dir, ...DIGEST_MANIFEST.split('/')), 'utf8').catch(() => undefined)));
    const keys = host.recall
      .archivable(ARCHIVE_DAYS, now, diary.timezone, MAX_ARCHIVE * 5)
      .filter((key) => {
        const name = key.replace(/^note:/, '');
        return !isDigestScope(name.split('/')[0] ?? '') && !digest.covered.has(name);
      })
      .slice(0, MAX_ARCHIVE);
    const archived = await archiveNotes(dir, keys);
    if (archived.moved.length > 0) {
      diary.deep.archived = archived.moved.length;
      files.push(...archived.files);
      logLines.push(...archiveChangelogLines(archived.moved));
    }
  }
  if (files.length === 0 && !diaryWorthWriting(diary)) return done();
  const written = await writeDiary(dir, diaryEntry(diary));
  if ('error' in written) notes.push(`梦境日记没写成：${written.error}`);
  else files.push(written.file);
  if (logLines.length > 0) {
    const logged = await writeChangelog(dir, deepChangelogEntry({ batchId: id, at: host.now(), timezone: diary.timezone, lines: logLines }));
    if ('file' in logged) files.push(logged.file);
  }
  if (files.length === 0) return done();
  const parts = [
    diary.deep.notesMerge?.notes ? `全局整合 ${diary.deep.notesMerge.notes} 篇笔记进 ${diary.deep.notesMerge.into} 个主题` : undefined,
    diary.deep.archived ? `归档 ${diary.deep.archived} 篇` : undefined,
    'file' in written ? '梦境日记' : undefined,
  ].filter(Boolean);
  const items = (diary.deep.notesMerge?.into ?? 0) + (diary.deep.archived ?? 0);
  const committed = await host.commitTarget(id, { ...target, items }, files, `深睡整理：${parts.join('、')}`);
  if (committed.phase !== 'committed') notes.push(`深睡整理没提交成：${committed.error ?? '提交失败'}`);
  else {
    const pushed = await host.pushAndOpen(id, committed);
    if (pushed.phase !== 'published') {
      // Merges made on a stale base are not worth a retry: the next night looks again.
      if (pushed.phase === 'committed') host.saveTarget(id, { ...pushed, phase: 'failed' });
      notes.push(`深睡整理没推成：${pushed.error ?? '推送失败'}`);
    }
  }
  return done();
}

/**
 * 深睡·全局整合: what changed in the raw notes since the manifest, folded
 * into the knowledge layer (see `./global-digest`). Only once the layer
 * exists: the first, full build is reviewed by hand as a PR of its own.
 */
async function digestNotes(
  host: DeepSleepHost,
  id: string,
  dir: string,
  ctx: { actor: DeepSleepActor; deadline: number; signal: AbortSignal },
): Promise<{ summary: NonNullable<DiaryInput['deep']['notesMerge']>; files: string[]; lines: string[] } | undefined> {
  if (ctx.deadline - host.now() <= 0 || ctx.signal.aborted) return undefined;
  const manifest = await readFile(join(dir, ...DIGEST_MANIFEST.split('/')), 'utf8').catch(() => undefined);
  if (manifest === undefined) return undefined;
  const restricted = new Set(Object.keys(host.deps.profileConfig().access.restrictedChats ?? {}).map(sanitizeScopeId));
  const result = await runDigest({
    dir,
    restricted,
    now: host.now(),
    deadline: ctx.deadline,
    run: (key, prompt) => host.runAgent(`dream:${id}:digest-${key}`, prompt, ctx.actor, Math.max(0, ctx.deadline - host.now()), ctx.signal),
  });
  if (result.errors.length > 0) log.warn('dream', 'digest-errors', { batch: id, errors: result.errors.slice(0, 20) });
  if (result.files.length === 0 && result.errors.length === 0) return undefined;
  return {
    summary: {
      notes: result.notes,
      into: result.topics,
      lifted: result.newTopics,
      dropped: result.dropped,
      ...(result.errors.length > 0 ? { error: `${result.errors.length} 处没通过（${result.errors[0]}${result.errors.length > 1 ? ' 等' : ''}），次晚重试` } : {}),
    },
    files: result.files,
    lines: result.changelog,
  };
}

/**
 * 深睡·记忆整合: one turn over the pending flags (and a global memory near
 * its budget), checked operation by operation, as a Draft PR of its own.
 * One at a time: while the last one waits for review, or within a few days
 * of it, nothing new is proposed. Undefined when there was nothing to do.
 */
async function consolidateMemory(
  host: DeepSleepHost,
  id: string,
  url: string,
  ctx: { actor: DeepSleepActor; deadline: number; signal: AbortSignal },
): Promise<NonNullable<DiaryInput['deep']['consolidation']> | undefined> {
  const none = { updated: 0, merged: 0, deleted: 0, dismissed: 0 };
  const earlier = host.state
    .runs()
    .filter((run) => run.id !== id)
    .flatMap((run) => run.targets.filter((target) => target.repo === MEMORY_REPO).map((target) => ({ run, target })));
  for (const { target } of earlier) {
    if (target.phase === 'committed' || target.phase === 'pushed') return { ...none, skipped: '上一份记忆整合还没开成 PR' };
    if (target.phase === 'pr-created' && target.prUrl) {
      const state = await pullRequestState(host.deps.workDir, target.prUrl);
      if (state !== '已合并' && state !== '已关闭') return { ...none, skipped: `上一份记忆整合 PR 还没审完（${target.prUrl}）` };
    }
  }
  if (earlier.some(({ run }) => host.now() - run.startedAt < MEMORY_COOLDOWN_MS)) return undefined;

  const label = '知识库（记忆整合）';
  let target: DreamTarget = { repo: MEMORY_REPO, label, branch: `${dreamBranch(id)}-memory`, phase: 'failed', items: 0 };
  const dir = join(host.deps.workDir, 'batches', id, 'memory');
  const prepared = await prepareCheckout({ repo: MEMORY_REPO, label, url }, dir, target.branch);
  if ('error' in prepared) return { ...none, error: prepared.error };
  const flags = await readPendingFlags(dir);
  const files = await readMemoryFiles(dir, flags);
  if (!memoryWorthConsolidating(flags, files)) return undefined;
  const remaining = ctx.deadline - host.now();
  if (remaining <= 0) return { ...none, skipped: '超出本轮运行时间' };
  const answer = await host.runAgent(`dream:${id}:memory`, buildMemoryPrompt({ flags, files }), ctx.actor, remaining, ctx.signal);
  if ('error' in answer) return { ...none, error: answer.error };
  const plan = parseMemoryOps(answer.text, { flags, files });
  if ('error' in plan) return { ...none, error: `模型输出不合格：${plan.error}` };
  const summary = memoryPlanSummary(plan);
  if (plan.ops.length === 0) return { ...summary, skipped: plan.rejected.length > 0 ? `提出的 ${plan.rejected.length} 个操作都没通过校验` : '没有需要改的' };
  const changed = await applyMemoryPlan(dir, plan, { flags, files });
  target = {
    ...target,
    base: prepared.base,
    checkoutDir: dir,
    items: plan.ops.length,
    title: memoryPrTitle(id, plan),
    body: memoryPrBody({ batchId: id, profile: host.deps.profile, plan, files, flags }),
  };
  const committed = await host.commitTarget(id, target, changed, `记忆整合：改写 ${summary.updated}、合并 ${summary.merged}、删除 ${summary.deleted}、关闭标记 ${summary.dismissed}`);
  if (committed.phase !== 'committed') return { ...summary, error: committed.error ?? '提交失败' };
  const opened = await host.pushAndOpen(id, committed);
  if (!opened.prUrl) return { ...summary, error: opened.error ?? '没开成 PR，下一轮重试' };
  return { ...summary, prUrl: opened.prUrl };
}
