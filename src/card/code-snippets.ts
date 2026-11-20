import { createHash } from 'node:crypto';
import { log } from '../core/logger';
import { JsonFile } from '../platform/json-file';

/** One fenced code block found in an answer. */
export interface CodeBlock {
  /** Info string after the opening fence, e.g. `sql`; empty when none. */
  lang: string;
  code: string;
}

/**
 * Fenced code blocks (``` or ~~~) in `markdown`, in order. An unclosed fence
 * (a streaming answer cut mid-block) is ignored, and so is an empty block.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open: { char: string; len: number; lang: string; body: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (!open) {
      const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (m) open = { char: m[1]![0]!, len: m[1]!.length, lang: m[2] ?? '', body: [] };
      continue;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1]![0] === open.char && close[1]!.length >= open.len) {
      const code = open.body.join('\n');
      if (code.trim()) blocks.push({ lang: open.lang, code });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

/** Short, stable key for a snippet: the same code always gets the same key. */
export function snippetKey(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

/**
 * A fence's info string, made safe to ride in a card button's `cmd`
 * (`copycode.<key>.<lang>`, split on dots): only letters, digits and `+#_-`,
 * at most 20 characters; empty when nothing usable is left.
 */
export function copyLang(lang: string): string {
  return /^[A-Za-z0-9+#_-]{1,20}$/.test(lang) ? lang : '';
}

/**
 * `code` as a rich-text (post) message holding one fenced block. Feishu turns
 * a fence inside a post's `md` element into a native code block, which —
 * unlike a code block on a card — has a copy icon that copies it whole.
 * Null when the code itself contains a ``` fence, which would close the
 * block early; send it as plain text then.
 */
export function codeBlockPost(code: string, lang = ''): object | null {
  if (code.includes('```')) return null;
  const text = `\`\`\`${copyLang(lang)}\n${code}\n\`\`\``;
  return { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } };
}

/**
 * Code blocks from finished answers, kept so the card's 「复制代码」 button
 * can carry just a key: putting the code itself on the button would double
 * the card's size against Feishu's 30 KB limit. Oldest entries go first once
 * the store holds {@link cap} of them; on disk so a restart keeps old cards
 * working.
 */
export class CodeSnippetStore {
  private readonly snippets = new Map<string, string>();
  private readonly file: JsonFile;

  constructor(
    path: string,
    private readonly cap = 500,
  ) {
    this.file = new JsonFile(path, {
      mode: 0o600,
      onLoadError: (err, movedTo) => log.fail('code-snippets', err, { step: 'load', ...(movedTo ? { movedTo } : {}) }),
      onPersistError: (err) => log.fail('code-snippets', err, { step: 'persist' }),
    });
  }

  async load(): Promise<void> {
    const raw = await this.file.load();
    if (!raw || typeof raw !== 'object') return;
    this.snippets.clear();
    for (const [key, code] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof code === 'string') this.snippets.set(key, code);
    }
  }

  /** Remember `code` and return its key. Re-putting known code only refreshes its age. */
  put(code: string): string {
    const key = snippetKey(code);
    const known = this.snippets.get(key) === code;
    this.snippets.delete(key);
    this.snippets.set(key, code);
    while (this.snippets.size > this.cap) {
      const oldest = this.snippets.keys().next().value;
      if (oldest === undefined) break;
      this.snippets.delete(oldest);
    }
    // A card re-renders many times while it fits itself to the size budget;
    // only new code is worth a write.
    if (!known) this.schedulePersist();
    return key;
  }

  get(key: string): string | undefined {
    return this.snippets.get(key);
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private schedulePersist(): void {
    this.file.write(`${JSON.stringify(Object.fromEntries(this.snippets))}\n`);
  }
}
