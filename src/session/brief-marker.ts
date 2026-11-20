/**
 * `[[BRIEF: …]]` — the one-line result summary the agent ends an answer with
 * in an owner-notify chat (see bot/owner-notify). Lives here, next to the
 * `[[NEW_SESSION]]` marker, so the card layer can strip it without depending
 * on the bot layer.
 */

/** `[[BRIEF: 一句话简述]]` anywhere in the answer (normally its last lines). */
const BRIEF_MARKER = /[ \t]*\[\[BRIEF[:：]\s*([^\]\n]*?)\s*\]\][ \t]*\n?/g;
/** A marker still arriving at the end of a stream: `[[`, `[[BRI`, `[[BRIEF: 已完`… */
const BRIEF_PARTIAL = /\s*\[\[(?:B(?:R(?:I(?:E(?:F(?:[:：][^\]\n]*)?)?)?)?)?)?$/;

const BRIEF_MAX = 120;

/** The agent's brief in `text`, if it wrote one (the last one wins). */
export function briefOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let found: string | undefined;
  for (const m of text.matchAll(BRIEF_MARKER)) {
    const s = m[1]?.trim();
    if (s) found = s;
  }
  return found ? clipBrief(found) : undefined;
}

/** `text` without its brief markers — complete, or still streaming in when `streaming`. */
export function stripBriefMarker(text: string, streaming = false): string {
  const done = text.includes('[[BRIEF') ? text.replace(BRIEF_MARKER, '').replace(/\s+$/, '') : text;
  if (!streaming) return done;
  const m = BRIEF_PARTIAL.exec(done);
  return m ? done.slice(0, m.index) : done;
}

/** One line, at most the brief's length. */
export function clipBrief(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > BRIEF_MAX ? `${one.slice(0, BRIEF_MAX - 1)}…` : one;
}
