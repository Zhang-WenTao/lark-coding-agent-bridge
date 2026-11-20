import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every slash command registered in the `handlers` table of
// src/commands/index.ts must be either an admin command (ADMIN_COMMANDS) or
// listed here as deliberately public. Adding a command forces a decision:
// gate it, or add it to PUBLIC_COMMANDS on purpose.
const PUBLIC_COMMANDS = [
  '/new',
  '/reset',
  '/resume',
  '/status',
  '/help',
  '/stop',
  '/copycode',
  '/timeout',
  '/doc',
  '/memory',
  '/skills',
  '/coffee',
  '/usage',
  '/approval',
];

const source = readFileSync(join(__dirname, '../../src/commands/index.ts'), 'utf8');

const block = (opening: RegExp): string => {
  const start = source.search(opening);
  expect(start, `${opening} not found in commands/index.ts`).toBeGreaterThanOrEqual(0);
  const end = source.slice(start).search(/\n(\]\)|\});/) + start;
  return source.slice(start, end);
};

const commandKeys = (text: string, quote: RegExp): string[] =>
  [...text.matchAll(quote)].map((m) => m[1]!);

const handlerKeys = commandKeys(block(/const handlers: Record<string, Handler> = \{/), /^\s*'(\/[a-z]+)':/gm);
const adminKeys = commandKeys(block(/const ADMIN_COMMANDS = new Set\(\[/), /^\s*'(\/[a-z]+)',/gm);

describe('command registry', () => {
  it('parses both tables', () => {
    expect(handlerKeys.length).toBeGreaterThan(20);
    expect(adminKeys.length).toBeGreaterThan(10);
  });

  it('every handler is an admin command or an explicitly public one', () => {
    const unclassified = handlerKeys.filter((k) => !adminKeys.includes(k) && !PUBLIC_COMMANDS.includes(k));
    expect(unclassified, 'add the command to ADMIN_COMMANDS, or to PUBLIC_COMMANDS in this test on purpose').toEqual([]);
  });

  it('public list has no stale or admin entries', () => {
    expect(PUBLIC_COMMANDS.filter((k) => !handlerKeys.includes(k))).toEqual([]);
    expect(PUBLIC_COMMANDS.filter((k) => adminKeys.includes(k))).toEqual([]);
  });

  it('every admin command has a handler', () => {
    expect(adminKeys.filter((k) => !handlerKeys.includes(k))).toEqual([]);
  });
});
