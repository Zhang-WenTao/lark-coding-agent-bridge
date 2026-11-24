import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import {
  CodeSnippetStore,
  codeBlockPost,
  copyLang,
  extractCodeBlocks,
  snippetKey,
} from '../../../src/card/code-snippets.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

/** Every button on the card, as [label, callback value]. */
function buttons(card: object): Array<[string, Record<string, unknown>]> {
  const found: Array<[string, Record<string, unknown>]> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const el = node as Record<string, unknown>;
    if (el.tag === 'button') {
      const value = (el.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value;
      found.push([(el.text as { content: string }).content, value]);
    }
    Object.values(el).forEach(walk);
  };
  walk(card);
  return found;
}

const SQL = "SELECT *\nFROM t\nWHERE a = '%&#x3D;%';";
const ANSWER = `结论如下：\n\n\`\`\`sql\n${SQL}\n\`\`\`\n\n再执行：\n\n~~~bash\nls -la\n~~~\n`;

describe('extractCodeBlocks', () => {
  it('finds backtick and tilde fences with their languages, keeping the code verbatim', () => {
    expect(extractCodeBlocks(ANSWER)).toEqual([
      { lang: 'sql', code: SQL },
      { lang: 'bash', code: 'ls -la' },
    ]);
  });

  it('keeps a shorter fence inside a longer one as code', () => {
    const md = '````md\n```js\nx()\n```\n````';
    expect(extractCodeBlocks(md)).toEqual([{ lang: 'md', code: '```js\nx()\n```' }]);
  });

  it('ignores unclosed and empty blocks', () => {
    expect(extractCodeBlocks('```sql\nSELECT 1')).toEqual([]);
    expect(extractCodeBlocks('```\n\n```')).toEqual([]);
  });
});

describe('the finished run card', () => {
  it('carries no copy buttons: an answer with code moves to a post instead (see deliverCodeNatively)', () => {
    const done = stateFrom([
      { type: 'text', delta: ANSWER },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(buttons(renderCard(done))).toEqual([]);
  });
});

describe('codeBlockPost', () => {
  it('wraps the code in one fenced md element, which Feishu shows as a code block with a copy icon', () => {
    const code = "SELECT '$$ $& x' AS b;\n\n\n-- end";
    expect(codeBlockPost(code, 'sql')).toEqual({
      zh_cn: { title: '', content: [[{ tag: 'md', text: `\`\`\`sql\n${code}\n\`\`\`` }]] },
    });
  });

  it('drops an unusable language and gives up on code holding a fence', () => {
    expect(JSON.stringify(codeBlockPost('ls', 'a b'))).toContain('"```\\nls\\n```"');
    expect(codeBlockPost('```js\nx()\n```', 'md')).toBeNull();
  });

  it('keeps only cmd-safe languages', () => {
    expect(copyLang('sql')).toBe('sql');
    expect(copyLang('c++')).toBe('c++');
    expect(copyLang('file.ts')).toBe('');
    expect(copyLang('')).toBe('');
    expect(copyLang('x'.repeat(21))).toBe('');
  });
});

describe('CodeSnippetStore', () => {
  it('returns stable keys, survives a reload, and drops the oldest past its cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snippets-'));
    const path = join(dir, 'code-snippets.json');
    const store = new CodeSnippetStore(path, 2);
    const a = store.put('a');
    expect(store.put('a')).toBe(a);
    const b = store.put('b');
    store.put('c');
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe('b');
    await store.flush();

    const reloaded = new CodeSnippetStore(path, 2);
    await reloaded.load();
    expect(reloaded.get(b)).toBe('b');
    expect(reloaded.get(snippetKey('c'))).toBe('c');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ [b]: 'b', [snippetKey('c')]: 'c' });
  });
});
