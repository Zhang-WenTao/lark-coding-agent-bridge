import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from '../../../src/platform/paths';

const HOME = '/Users/someone';

/** The copies `expandHome` replaced, kept here to pin that nothing changed. */
const before = {
  /** policy/owner-guard.ts ×3 */
  guard: (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p),
  /** dream/external.ts, dream/service.ts, dream/recall.ts: no bare `~` */
  dream: (p: string, home: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p),
  /** commands/index.ts `/cd`: string concatenation, then realpath'd */
  cd: (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? `${home}${p.slice(1)}` : p),
};

const inputs = ['~', '~/', '~/a', '~/a/b/', '~/a/../b', '/abs/path', 'rel/path', '~user/x', '$HOME/x', '', ' ~/x'];

describe('expandHome', () => {
  it('matches the guard copies on every input', () => {
    for (const p of inputs) expect(expandHome(p, HOME), p).toBe(before.guard(p, HOME));
  });

  it('matches the dream copies except that a bare ~ now means home', () => {
    for (const p of inputs.filter((p) => p !== '~')) expect(expandHome(p, HOME), p).toBe(before.dream(p, HOME));
    expect(expandHome('~', HOME)).toBe(HOME);
  });

  it('lands /cd on the same directory as before (it is realpath\'d next)', () => {
    for (const p of inputs) expect(resolve(expandHome(p, HOME)), p).toBe(resolve(before.cd(p, HOME)));
  });

  it('defaults to the real home directory', () => {
    expect(expandHome('~/x')).toMatch(/\/x$/);
    expect(expandHome('~/x').startsWith('~')).toBe(false);
  });
});
