/**
 * 任务体量: how much quota a run is likely to use, apart from how hard it is
 * to think about (the effort rung). Measured on the bridge's own logs,
 * 2026-11-10 → 11-25 (1,230 runs with a cost, $3,056 at API prices):
 *
 *   size  share of runs  cost median / P75 / P90   share of cost
 *   S     42.1%          $0.48 / 0.77 / 1.00         9.1%
 *   M     38.0%          $1.54 / 2.10 / 2.87        26.7%
 *   L     17.2%          $4.37 / 6.20 / 8.43        32.7%
 *   XL     2.7%          $19.1 / 25.7 / 43.0        31.5%
 *
 * Effort alone is a poor guide: half the xhigh / max runs were S or M, and
 * the costliest runs were highs that fanned out to six or more subagents.
 * What tells the size is the work: subagents, tool calls, background tasks,
 * a task ledger. Those show up early (the first one at 8% of a big run's
 * time, median), so a run starts on an estimate and is resized as it goes.
 */

export type TaskSize = 'S' | 'M' | 'L' | 'XL';
export const TASK_SIZES: readonly TaskSize[] = ['S', 'M', 'L', 'XL'];

/** What a run of each size is held to use, in API dollars: the P90 of the measured runs. */
export const DEFAULT_SIZE_RESERVE_USD: Record<TaskSize, number> = { S: 1, M: 3, L: 8.5, XL: 43 };
/** How long a run of each size is expected to take (P90 of the measured runs). */
export const SIZE_DURATION_MS: Record<TaskSize, number> = {
  S: 2 * 60_000,
  M: 8 * 60_000,
  L: 25 * 60_000,
  XL: 135 * 60_000,
};
/** How much of an account's big-task load a run takes (see `maxBigLoad`). */
export const SIZE_LOAD: Record<TaskSize, number> = { S: 0, M: 0, L: 1, XL: 2 };

/** Tool calls in one run from which it counts as L / XL. */
export const TOOL_CALLS_L = 50;
export const TOOL_CALLS_XL = 150;
/** Subagents started in one run from which it counts as XL (one makes it L). */
export const SUBAGENTS_XL = 6;
/** A run that spent this share of its reserve moves up one size. */
export const RESERVE_TOP_UP_SHARE = 0.8;

export function isBigSize(size: TaskSize): boolean {
  return size === 'L' || size === 'XL';
}

export function sizeRank(size: TaskSize): number {
  return TASK_SIZES.indexOf(size);
}

export function maxSize(a: TaskSize, b: TaskSize): TaskSize {
  return sizeRank(a) >= sizeRank(b) ? a : b;
}

export function nextSize(size: TaskSize): TaskSize {
  return TASK_SIZES[Math.min(TASK_SIZES.length - 1, sizeRank(size) + 1)]!;
}

/** The size a run of this cost belongs to (the geometric middle between the sizes' medians). */
export function costToSize(usd: number): TaskSize {
  if (usd >= 9) return 'XL';
  if (usd >= 2.6) return 'L';
  if (usd >= 0.9) return 'M';
  return 'S';
}

/** What the effort rating says about the work, besides its difficulty. */
export interface RatingScale {
  /** Subagents the task should fan out to (0–9). */
  subagents?: number;
  /** It needs a build, a full test run or another long wait in the background. */
  background?: boolean;
  /** It is likely to take over 30 minutes or to need a task ledger. */
  long?: boolean;
}

/** The size a run starts with, and why: carried from the chat to the account pick. */
export interface SizeHint {
  size: TaskSize;
  /** The signals behind it, for the log. */
  why: string[];
  /** A short follow-up ("继续"): the conversation's last size counts too. */
  continuation?: boolean;
}

export interface PreRunSizeInput {
  scale?: RatingScale;
  /** The rung's effort label (`medium`, `high`, `xhigh`, `max`). */
  effort?: string;
  /** The batch's text, for command prefixes. */
  text?: string;
  /** Command prefixes that start big work, e.g. `{ "/jira-dev": "L" }`. */
  bigCommands?: Readonly<Record<string, TaskSize>>;
  continuation?: boolean;
}

/** Commands whose runs are big by the logs; `scheduling.bigCommands` adds to or overrides them. */
export const DEFAULT_BIG_COMMANDS: Readonly<Record<string, TaskSize>> = {
  '/pr-deep-review': 'XL',
  '/usage-weekly': 'XL',
  '/release-local-ci': 'XL',
  '/jira-dev': 'L',
  '/jira-task': 'L',
  '/github-pr': 'L',
  '/deploy': 'L',
  '/security-scan': 'L',
  '/incident-report': 'L',
};

/**
 * The size a run starts on, before any of its work is seen:
 * - the rating's own estimate of the work (subagents, background, long);
 * - a command known to start big work;
 * - the effort rung, only as a weak prior: at most M.
 */
export function preRunSize(input: PreRunSizeInput): SizeHint {
  let size: TaskSize = 'S';
  const why: string[] = [];
  const raise = (to: TaskSize, reason: string): void => {
    if (sizeRank(to) > sizeRank(size)) size = to;
    why.push(reason);
  };
  const scale = input.scale;
  if (scale) {
    const n = scale.subagents ?? 0;
    if (n >= SUBAGENTS_XL || (n >= 3 && scale.long)) raise('XL', `rating:subagents=${n}${scale.long ? '+long' : ''}`);
    else if (n >= 1) raise('L', `rating:subagents=${n}`);
    if (scale.background) raise('L', 'rating:background');
    if (scale.long) raise('L', 'rating:long');
  }
  const command = commandSize(input.text, input.bigCommands);
  if (command) raise(command.size, `command:${command.name}`);
  if (input.effort === 'xhigh' || input.effort === 'max') raise('M', `effort:${input.effort}`);
  else if (input.effort === 'high') raise('S', 'effort:high');
  return { size, why, ...(input.continuation ? { continuation: true } : {}) };
}

/** The size a command at the start of any line of the batch calls for. */
export function commandSize(
  text: string | undefined,
  extra?: Readonly<Record<string, TaskSize>>,
): { name: string; size: TaskSize } | undefined {
  if (!text) return undefined;
  const table = { ...DEFAULT_BIG_COMMANDS, ...(extra ?? {}) };
  let best: { name: string; size: TaskSize } | undefined;
  for (const line of text.split('\n')) {
    const head = /^\s*(\/[\w:-]+)/.exec(line)?.[1]?.toLowerCase();
    if (!head) continue;
    // `/antelope:jira-dev` and `/jira-dev` are the same command.
    const short = head.includes(':') ? `/${head.split(':').pop()}` : head;
    const size = table[head] ?? table[short];
    if (size && (!best || sizeRank(size) > sizeRank(best.size))) best = { name: head, size };
  }
  return best;
}

/** What a run has done so far, as the size it shows. */
export interface RunWork {
  tools: number;
  subagents: number;
  background: number;
  ledger: boolean;
}

export function sizeOfWork(work: RunWork): TaskSize {
  if (work.subagents >= SUBAGENTS_XL || work.tools >= TOOL_CALLS_XL) return 'XL';
  if (work.subagents >= 1 || work.tools >= TOOL_CALLS_L || work.background > 0 || work.ledger) return 'L';
  if (work.tools >= 10) return 'M';
  return 'S';
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** The line a run writes when it keeps a task ledger (`📒 任务台账：/path.md`). */
const LEDGER_MARK = '任务台账：';

/** The tool starts a subagent. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name);
}

/**
 * Follows one run's work and says when it has outgrown its size. Sizes only
 * go up while the run lasts.
 */
export class SizeTracker {
  private size: TaskSize;
  private readonly work: RunWork = { tools: 0, subagents: 0, background: 0, ledger: false };
  private spentUsd = 0;
  private textTail = '';

  constructor(
    initial: TaskSize,
    private readonly reserveOf: (size: TaskSize) => number = (s) => DEFAULT_SIZE_RESERVE_USD[s],
  ) {
    this.size = initial;
  }

  get current(): TaskSize {
    return this.size;
  }

  get spent(): number {
    return this.spentUsd;
  }

  get done(): Readonly<RunWork> {
    return this.work;
  }

  /**
   * What the run is held to use in all: its size's reserve, and once an XL
   * run has spent {@link RESERVE_TOP_UP_SHARE} of that, a quarter more than
   * it has spent (its tail is long: one run cost $202).
   */
  reserveUsd(): number {
    return Math.max(this.reserveOf(this.size), this.spentUsd / RESERVE_TOP_UP_SHARE);
  }

  /** A tool call started; the new size when it outgrew the old one. */
  onToolUse(name: string): TaskSize | undefined {
    this.work.tools += 1;
    if (SUBAGENT_TOOLS.has(name)) this.work.subagents += 1;
    return this.settle();
  }

  onBackground(count: number): TaskSize | undefined {
    this.work.background = Math.max(this.work.background, count);
    return this.settle();
  }

  onText(delta: string): TaskSize | undefined {
    if (this.work.ledger) return undefined;
    // A mark split across deltas still counts; a whole reply is searched in full.
    const joined = this.textTail + delta;
    this.textTail = joined.slice(-LEDGER_MARK.length);
    if (!joined.includes(LEDGER_MARK)) return undefined;
    this.work.ledger = true;
    return this.settle();
  }

  /** A turn's cost came in; past {@link RESERVE_TOP_UP_SHARE} of the reserve the run moves up one size. */
  onCost(usd: number): TaskSize | undefined {
    this.spentUsd += usd;
    let grown: TaskSize | undefined;
    while (this.size !== 'XL' && this.spentUsd >= RESERVE_TOP_UP_SHARE * this.reserveOf(this.size)) {
      this.size = nextSize(this.size);
      grown = this.size;
    }
    return grown ?? this.settle();
  }

  private settle(): TaskSize | undefined {
    const shown = sizeOfWork(this.work);
    if (sizeRank(shown) <= sizeRank(this.size)) return undefined;
    this.size = shown;
    return shown;
  }
}
