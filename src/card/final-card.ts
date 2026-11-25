import type { CardHeaderTemplate } from '../config/schema';
import { runStrings, type Locale } from './i18n';
import { deepMaskEmails } from './mask-email';
import { pauseNotice } from './pause-notice';
import { backgroundLeft, type RunState } from './run-state';

/**
 * `messageReply: 'final-card'`: the answer as one clean card, sent once when
 * the run is over. Nothing of the run itself is on it — no progress, stop
 * button, tool blocks, reasoning, byline, or the bridge's own notes (account
 * switch, mid-run supplement, a fresh conversation). Pass the final answer
 * only (`finalAnswerState`, then the prefs filter).
 *
 * A short answer is just the text, like a chat message. A long one (more than
 * {@link FINAL_CARD_HEADER_AFTER_LINES} lines, or a table) gets a header bar
 * titled with what the answer is about (see {@link answerTopic}) — not the
 * bot's name, which the message's sender line already shows.
 */

/** Answers longer than this many non-blank lines get a header bar. */
export const FINAL_CARD_HEADER_AFTER_LINES = 6;
const TITLE_MAX = 24;
const SUMMARY_MAX = 60;
const ERROR_MAX = 80;

export interface FinalCardOptions {
  /** Header title of last resort, when no topic can be read off the answer. */
  botName: string;
  headerTemplate: CardHeaderTemplate;
  /** Image key for the header icon (the bot's avatar). */
  headerIcon?: string;
  /** Model name for the optional grey footer line; none when absent. */
  footerModel?: string;
  locale?: Locale;
}

/** The card, or undefined when there is nothing to show (an empty or `[[NO_REPLY]]` answer). */
export function renderFinalCard(state: RunState, opts: FinalCardOptions): object | undefined {
  let answer = finalCardAnswer(state);
  const status = finalCardStatus(state, opts.locale);
  if (!answer && !status) return undefined;

  let title: string | undefined;
  if (answer && needsHeader(answer)) {
    const topic = answerTopic(answer);
    title = topic?.title ?? (opts.botName.trim() || runStrings(opts.locale).summary.done);
    if (topic?.rest !== undefined) answer = topic.rest;
  }

  const elements: object[] = [];
  if (answer) elements.push({ tag: 'markdown', content: answer });
  if (status) elements.push(greyLine(status));
  if (opts.footerModel) elements.push(greyLine(opts.footerModel));

  return deepMaskEmails({
    schema: '2.0',
    config: { width_mode: 'fill', summary: { content: summaryOf(title ?? answer, status) } },
    ...(title
      ? {
          header: {
            template: opts.headerTemplate,
            title: { tag: 'plain_text', content: title },
            ...(opts.headerIcon ? { icon: { tag: 'custom_icon', img_key: opts.headerIcon } } : {}),
          },
        }
      : {}),
    body: { elements },
  });
}

/** The same content as plain markdown, for when the card cannot be sent. */
export function finalCardText(state: RunState, locale?: Locale): string {
  return [finalCardAnswer(state), finalCardStatus(state, locale)].filter(Boolean).join('\n\n');
}

/** What the agent wrote: text blocks without the bridge's own notes. */
export function finalCardAnswer(state: RunState): string {
  return state.blocks
    .flatMap((b) => (b.kind === 'text' && !b.note ? [b.content.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
}

/** How the run ended, when that is worth a word: one short line, never a stack of error text. */
export function finalCardStatus(state: RunState, locale?: Locale): string | undefined {
  const t = runStrings(locale);
  switch (state.terminal) {
    case 'interrupted':
      return state.interruptReason === 'recalled' ? t.recalled : t.interrupted;
    case 'idle_timeout':
      return t.idleTimeout(state.idleTimeoutMinutes ?? 0);
    case 'paused':
      return oneLine(pauseNotice(state.limit, locale));
    case 'error':
      return state.errorMsg ? t.agentFailed(truncate(oneLine(state.errorMsg), ERROR_MAX)) : t.summary.error;
    default: {
      const background = backgroundLeft(state);
      return background > 0 ? t.backgroundRunning(background) : undefined;
    }
  }
}

export function needsHeader(answer: string): boolean {
  if (hasTable(answer)) return true;
  return answer.split('\n').filter((line) => line.trim()).length > FINAL_CARD_HEADER_AFTER_LINES;
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** A markdown table outside code fences: a row of `---` cells under a header row. */
export function hasTable(answer: string): boolean {
  let fenced = false;
  for (const line of answer.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && TABLE_SEPARATOR.test(line)) return true;
  }
  return false;
}

/**
 * What the answer is about, as a short header title:
 *  1. its leading `#` / `##` / `###` heading — the agent can open a long
 *     answer with one to name it; the heading then leaves the body (`rest`);
 *  2. else its opening sentence: the first line of prose (not a table row or
 *     code fence), up to the first full stop or colon, or up to the first
 *     comma when the sentence is long; cut at {@link TITLE_MAX} characters.
 * Undefined when the answer opens with a table or code, so the caller falls
 * back to the bot's name.
 */
export function answerTopic(answer: string): { title: string; rest?: string } | undefined {
  const lines = answer.split('\n');
  const first = lines.find((line) => line.trim()) ?? '';
  const heading = /^\s*#{1,3}\s+(.+?)\s*#*\s*$/.exec(first);
  if (heading?.[1]) {
    const body = lines.slice(lines.indexOf(first) + 1).join('\n').trim();
    const title = truncateTitle(plain(heading[1]));
    if (title && body) return { title, rest: body };
  }
  if (/^\s*(\||```)/.test(first)) return undefined;
  const sentence = plain(first).split(/[。！？!?；;：:]/)[0]?.trim() ?? '';
  const clause = sentence.length > TITLE_MAX ? (sentence.split(/[，,]/)[0]?.trim() ?? '') : sentence;
  const title = truncateTitle(clause.length >= 2 ? clause : sentence);
  return title ? { title } : undefined;
}

function greyLine(text: string): object {
  return { tag: 'markdown', content: `<font color='grey'>${text}</font>`, text_size: 'notation' };
}

function summaryOf(text: string, status: string | undefined): string {
  const first = text.split('\n').find((line) => line.trim()) ?? '';
  return truncate(plain(first), SUMMARY_MAX) || plain(status ?? '');
}

/** Markdown marks off, for plain-text spots (header title, chat-list preview). */
function plain(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .replace(/^\s*[-*>]\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

/** Cut to {@link TITLE_MAX}, backing off to a word boundary rather than splitting a Latin word. */
function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const word = /[A-Za-z0-9_-]/;
  let cut = TITLE_MAX - 1;
  while (cut > TITLE_MAX / 2 && word.test(text[cut - 1] ?? '') && word.test(text[cut] ?? '')) cut--;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
