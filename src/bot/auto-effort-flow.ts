import {
  allowedRungs,
  classify,
  decideRung,
  forcedRung,
  isShortFollowUp,
  type AutoEffortScopeState,
  type AutoEffortSettings,
  type AutoEffortStore,
  type ClassifierAnswer,
  type ClassifierInput,
  type RungDecision,
} from '../agent/auto-effort';
import { type RatingScale, type SizeHint, type TaskSize, preRunSize } from '../agent/claude/task-size';
import type { EffortLevel } from '../config/schema';
import { log } from '../core/logger';

/** The rung one run landed on, for submit and the reply card. */
export interface AutoEffortPick {
  label: string;
  model: string;
  effort: EffortLevel;
  via: RungDecision['via'];
  /** The rung the conversation was on before; undefined on a new one. */
  from?: string;
  reason?: string;
  /** 任务体量: the size the run starts on, for the account pick. */
  size?: SizeHint;
}

export interface AutoEffortPlan {
  /** Set when the message opens with `/<rung>`: tell the agent it is not a request. */
  forcedLabel?: string;
  /** Where the run lands, given the conversation it resumes (undefined: a new one). Never throws. */
  pick(resumeFrom: string | undefined, liveProcess: boolean): Promise<AutoEffortPick | undefined>;
  /** Record how the run ended, for the next rating. */
  finish(outcome: { handle?: string; terminal?: string; durationMs: number }): void;
}

export interface StartAutoEffortInput {
  settings: AutoEffortSettings;
  store: AutoEffortStore;
  scope: string;
  /** The batch's messages, oldest first. */
  texts: string[];
  attachments: number;
  quoted?: string;
  chatType: 'p2p' | 'group';
  owner: boolean;
  /** The chat's effort (`chatEffort`, else `effort`): the ceiling for runs the owner didn't start. */
  cap?: EffortLevel;
  classify: { cwd: string; env: () => Record<string, string>; binary?: string };
  /** How full a quota window is on the account the run would get; undefined when unknown (the rung stays usable). */
  windowUsed?: (kind: string) => number | undefined;
  /** Command prefixes that start big work, over the built-in ones (`scheduling.bigCommands`). */
  bigCommands?: () => Readonly<Record<string, TaskSize>> | undefined;
  /** How long the run waits for the rating (defaults: {@link RATING_WAIT_MS}). */
  ratingWaitMs?: { followUp: number; fresh: number };
  now?: () => number;
}

/**
 * How long a run waits for the rating before it starts. The rating takes
 * about 4 s (median; up to 30 s), which was most of the delay before a
 * reply started. A follow-up in a conversation that already has a rung
 * starts on it right away and the rating, when it lands, sets the rung for
 * the next message; a new conversation has nothing to go on, so it waits,
 * up to a cap.
 */
export const RATING_WAIT_MS = { followUp: 0, fresh: 6_000 } as const;

/** `p` if it settles within `ms`; with `ms` 0 an already-settled `p` still counts. */
function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([p.then((value) => ({ done: true as const, value })), timeout]).finally(() => clearTimeout(timer));
}

/** `xhigh（自动↑）` for the reply card's Effort line. */
export function autoEffortByline(pick: AutoEffortPick): string {
  const how =
    pick.via === 'forced' ? '指定' : pick.via === 'up' ? '自动↑' : pick.via === 'down' ? '自动↓' : '自动';
  return `${pick.effort}（${how}）`;
}

/**
 * Start rating the batch right away (the call takes a few seconds; the run
 * is prepared meanwhile) and settle the rung once the conversation the run
 * resumes is known.
 */
export function startAutoEffort(input: StartAutoEffortInput): AutoEffortPlan {
  const { settings, store, scope } = input;
  const { ladder } = settings;
  const now = input.now ?? Date.now;
  const text = input.texts.join('\n').trim();
  let forced: number | undefined;
  for (const t of [...input.texts].reverse()) {
    forced = forcedRung(ladder, t);
    if (forced !== undefined) break;
  }
  const short = isShortFollowUp(text, input.attachments);
  const known = store.get(scope);
  const startedAt = now();
  const rating: Promise<ClassifierAnswer | undefined> =
    forced === undefined && !short
      ? classify(
          settings,
          {
            text,
            chatType: input.chatType,
            ...(input.quoted ? { quoted: input.quoted } : {}),
            ...(known ? { current: ladder[known.rung]?.label, ...(known.last ? { last: known.last } : {}) } : {}),
          } satisfies ClassifierInput,
          { cwd: input.classify.cwd, env: input.classify.env(), ...(input.classify.binary ? { binary: input.classify.binary } : {}) },
        ).catch(() => undefined)
      : Promise.resolve(undefined);
  const wait = input.ratingWaitMs ?? RATING_WAIT_MS;
  let picked: { rung: number; downVotes: number } | undefined;
  /** The rung the run itself is on (`picked` may move on when a late rating lands). */
  let ranOn: number | undefined;
  /** What the store last got for this run, so a late rating keeps the handle and outcome. */
  let record: { handle?: string; last?: AutoEffortScopeState['last'] } = {};
  // Models that just failed, plus those whose own window is past the line.
  const blockedModels = (): Set<string> => {
    const out = store.blockedModels(now());
    for (const rung of ladder) {
      if (!rung.quotaWindow || out.has(rung.model)) continue;
      const used = input.windowUsed?.(rung.quotaWindow);
      if (used !== undefined && used >= settings.quotaLine) {
        out.add(rung.model);
        log.info('auto-effort', 'quota-skip', { scope, model: rung.model, window: rung.quotaWindow, used });
      }
    }
    return out;
  };

  // The run started without the rating: when it lands, it sets the rung the
  // conversation's next message starts from (the run keeps its own).
  const applyLateRating = (allowed: number[], started: RungDecision): void => {
    void rating.then((rated) => {
      if (!rated || !picked) return;
      const next = decideRung({
        ladder,
        allowed,
        current: { rung: started.rung, downVotes: started.downVotes },
        target: rated.rung,
      });
      picked = { rung: next.rung, downVotes: next.downVotes };
      store.set(scope, { rung: next.rung, downVotes: next.downVotes, ...record }, now());
      log.info('auto-effort', 'late-rating', {
        scope,
        ran: ladder[started.rung]?.label,
        next: ladder[next.rung]?.label,
        via: next.via,
        ...(rated.reason ? { reason: rated.reason } : {}),
        waitedMs: now() - startedAt,
      });
    });
  };

  return {
    ...(forced !== undefined ? { forcedLabel: ladder[forced]!.label } : {}),
    async pick(resumeFrom, liveProcess) {
      try {
        const current = store.forConversation(scope, resumeFrom);
        // A manual rung (Fable) is in only when this message's prefix named it,
        // or when a short follow-up ("继续") continues a run that was on it.
        const manual = forced ?? (short && current && ladder[current.rung]?.manual ? current.rung : undefined);
        const allowed = allowedRungs(ladder, {
          owner: input.owner,
          ...(input.cap ? { cap: input.cap } : {}),
          blockedModels: blockedModels(),
          ...(manual !== undefined ? { manual } : {}),
        });
        if (allowed.length === 0) return undefined;
        let decision: RungDecision;
        let reason: string | undefined;
        let scale: RatingScale | undefined;
        let late = false;
        if (liveProcess && current) {
          // The message goes to the process this scope still runs: it keeps its model and effort.
          decision = { rung: current.rung, downVotes: current.downVotes, via: 'stay' };
        } else if (forced === undefined && short) {
          // A follow-up keeps the rung; a short opener starts at the bottom.
          decision = current
            ? decideRung({ ladder, allowed, current, target: current.rung })
            : decideRung({ ladder, allowed });
        } else {
          const waitMs = forced !== undefined ? 0 : current ? wait.followUp : wait.fresh;
          const settled = await within(rating, waitMs);
          const rated = settled.done ? settled.value : undefined;
          reason = rated?.reason;
          scale = rated?.scale;
          decision = decideRung({
            ladder,
            allowed,
            ...(current ? { current: { rung: current.rung, downVotes: current.downVotes } } : {}),
            ...(rated ? { target: rated.rung } : {}),
            ...(forced !== undefined ? { forced } : {}),
          });
          if (!settled.done) {
            late = true;
            if (!current) log.info('auto-effort', 'rating-timeout', { scope, waitMs });
            applyLateRating(allowed, decision);
          }
        }
        const rung = ladder[decision.rung]!;
        const from = current ? ladder[current.rung]?.label : undefined;
        picked = { rung: decision.rung, downVotes: decision.downVotes };
        ranOn = decision.rung;
        record = { ...(resumeFrom ? { handle: resumeFrom } : {}), ...(current?.last ? { last: current.last } : {}) };
        store.set(scope, { rung: decision.rung, downVotes: decision.downVotes, ...record }, now());
        log.info('auto-effort', 'picked', {
          scope,
          rung: rung.label,
          via: decision.via,
          ...(from ? { from } : {}),
          ...(reason ? { reason } : {}),
          short,
          ...(late ? { ratingPending: true } : {}),
          waitedMs: now() - startedAt,
        });
        const size = preRunSize({
          ...(scale ? { scale } : {}),
          effort: rung.effort,
          text,
          ...(input.bigCommands?.() ? { bigCommands: input.bigCommands()! } : {}),
          // A follow-up, or a message for the process still running: the conversation's own size counts.
          ...(short || (liveProcess && current) || (late && current) ? { continuation: true } : {}),
        });
        log.info('auto-effort', 'size', { scope, size: size.size, why: size.why, ...(size.continuation ? { continuation: true } : {}) });
        return {
          label: rung.label,
          model: rung.model,
          effort: rung.effort,
          via: decision.via,
          ...(from ? { from } : {}),
          ...(reason ? { reason } : {}),
          size,
        };
      } catch (err) {
        log.warn('auto-effort', 'pick-failed', { scope, err: String(err) });
        return undefined;
      }
    },
    finish(outcome) {
      if (!picked || ranOn === undefined) return;
      const rung = ladder[ranOn];
      // A failed run on a model other than the bottom one (Fable): its quota
      // may be spent, so skip it for a while instead of failing again.
      // "Fable 5.2 requires usage credits" ends the run as paused (read as a
      // spent quota), so a pause counts too.
      if ((outcome.terminal === 'error' || outcome.terminal === 'paused') && rung && rung.model !== ladder[0]?.model) {
        store.blockModel(rung.model, now());
        log.warn('auto-effort', 'model-blocked', { scope, model: rung.model });
      }
      record = {
        ...(outcome.handle ? { handle: outcome.handle } : record.handle ? { handle: record.handle } : {}),
        last: { ...(outcome.terminal ? { terminal: outcome.terminal } : {}), durationMs: outcome.durationMs },
      };
      store.set(scope, { rung: picked.rung, downVotes: picked.downVotes, ...record }, now());
    },
  };
}
