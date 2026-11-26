import { formatMoment, runStrings, type Locale } from './i18n';
import type { RunState } from './run-state';

/**
 * `[[RESUME_AT: …]]`, `[[RESUME_AFTER: …]]`, `[[RESUME_CANCEL]]` — the agent
 * pausing a long owner task on purpose and asking the bridge to start it
 * again later (see bot/scheduled-resume). The agent's own timers and
 * background sleeps die with its process; these outlive it.
 *
 *   [[RESUME_AT: 2026-11-26T18:00 | /abs/ledger.md]]  at that time (host clock), or `18:00`: the next 18:00
 *   [[RESUME_AFTER: five_hour | /abs/ledger.md]]      once the current 5-hour quota window resets
 *   [[RESUME_CANCEL]]                                 drop the resume still pending
 *
 * The ledger part is optional. A marker counts only as a line of its own,
 * outside fenced code: an answer that talks about the markers (work on this
 * very bridge) shows them as written and schedules nothing. The bridge strips
 * marker lines in every reply mode and notes on the reply what became of the
 * request ({@link ResumeNote}).
 */

export type ResumeRequest =
  | { kind: 'at'; time: string; ledger?: string }
  | { kind: 'after'; window: string; ledger?: string }
  | { kind: 'cancel' };

/** Why a marker was not honoured; the reply says so. */
export type ResumeRejectReason =
  | 'not-owner'
  | 'bad-time'
  | 'past'
  | 'too-far'
  | 'bad-window'
  | 'no-reset'
  | 'bad-ledger'
  | 'too-many';

/** What became of the agent's marker, shown under its answer. */
export type ResumeNote =
  | { kind: 'scheduled'; at: number; ledger?: string; clamped?: boolean }
  | { kind: 'cancelled'; at: number }
  | { kind: 'rejected'; reason: ResumeRejectReason };

const MARKER_LINE = /^[ \t]*\[\[RESUME_(AT|AFTER|CANCEL)(?:[ \t]*[:：][ \t]*([^\]\n]*?))?[ \t]*\]\][ \t]*\r?$/;
const FENCE = /^[ \t]*(?:```|~~~)/;
const PREFIX = '[[RESUME_';

/** The agent's request in `text`, if a line of it is a marker (the last one wins). */
export function resumeRequestOf(text: string | undefined): ResumeRequest | undefined {
  if (!text?.includes(PREFIX)) return undefined;
  let found: ResumeRequest | undefined;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    const m = fenced ? null : MARKER_LINE.exec(line);
    if (m) found = toRequest(m[1]!, m[2] ?? '');
  }
  return found;
}

/** The request in a run's text: everything the agent wrote, notes before its last tool call included. */
export function resumeRequestIn(state: RunState): ResumeRequest | undefined {
  const texts = state.blocks.flatMap((b) => (b.kind === 'text' && !b.note ? [b.content] : []));
  if (state.finalText) texts.push(state.finalText);
  return resumeRequestOf(texts.join('\n'));
}

function toRequest(kind: string, args: string): ResumeRequest {
  if (kind === 'CANCEL') return { kind: 'cancel' };
  const [head = '', ...rest] = args.split(/[|｜]/);
  const ledger = rest.join('|').trim().replace(/^`|`$/g, '');
  const value = head.trim();
  return kind === 'AT'
    ? { kind: 'at', time: value, ...(ledger ? { ledger } : {}) }
    : { kind: 'after', window: value, ...(ledger ? { ledger } : {}) };
}

/** A marker line still arriving at the end of a stream: `[[`, `[[RESU`, `[[RESUME_AT: 18`… */
function isPartialMarker(line: string): boolean {
  const t = line.trim();
  return t.startsWith('[[') && !t.includes(']]') && (PREFIX.startsWith(t) || t.startsWith(PREFIX));
}

/** `text` without its marker lines — complete, or still streaming in when `streaming`. */
export function stripResumeMarkers(text: string, streaming = false): string {
  if (!text.includes('[[')) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let fenced = false;
  let changed = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      kept.push(line);
      return;
    }
    const marker = !fenced && (MARKER_LINE.test(line) || (streaming && i === lines.length - 1 && isPartialMarker(line)));
    if (marker) changed = true;
    else kept.push(line);
  });
  return changed ? kept.join('\n').replace(/\s+$/, '') : text;
}

/** The line under the answer saying what became of the marker. */
export function resumeNotice(note: ResumeNote, locale?: Locale): string {
  const t = runStrings(locale);
  switch (note.kind) {
    case 'scheduled':
      return t.resumeScheduled(formatMoment(note.at), Boolean(note.ledger), note.clamped === true);
    case 'cancelled':
      return t.resumeCancelled(formatMoment(note.at));
    default:
      return t.resumeRejected(t.resumeRejectReasons[note.reason]);
  }
}

/**
 * Run instruction for the owner's runs: when and how to pause a task with a
 * marker. `pending` is the resume already agreed in this conversation, so the
 * agent can cancel or replace it when the owner changes their mind.
 */
export function scheduledResumeInstruction(pending?: { at: number; ledger?: string }): string {
  return (
    '主人的长任务要按约定暂停、过段时间再接着做时（例如主人说「5 小时额度超过 50% 就停，重置后再做」），' +
    '不要用后台 sleep、定时器或 CronCreate 等着（这一轮结束后进程就没了）：先把进度和「下一步」写进任务台账，' +
    '再在最终回复里单独一行写 `[[RESUME_AFTER: five_hour | 台账绝对路径]]`（当前 5 小时额度窗口重置后约 2 分钟继续），' +
    '或 `[[RESUME_AT: 2026-11-26T18:00 | 台账绝对路径]]`（本机时间，只写 18:00 表示下一个 18:00；须在 5 分钟到 24 小时之后）。' +
    '到点后 bridge 会在同一会话里让你从台账的「下一步」接着做；台账可省略，省略时用本轮「📒 任务台账」那一行。' +
    '主人让你先别做、或计划作废时写 `[[RESUME_CANCEL]]`；新写的会替换旧的。只在确实要暂停时写，不要同时写 `[[NEW_SESSION…]]`。' +
    '这些行对用户不可见，bridge 会在回复下注明继续时间，正文里不用提标记。' +
    (pending
      ? `当前已约定 ${formatMoment(pending.at)} 自动继续${pending.ledger ? `（台账 ${pending.ledger}）` : ''}。`
      : '')
  );
}
