import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expand a leading `~` the way a config path or `/cd ~/x` means it: `~` is
 * `home`, `~/x` is `x` under `home`, anything else is returned untouched
 * (`~user` and `$HOME` included). Shell words in approval rules have their
 * own rules, see `runtime/approvals.ts`; the guard hook in
 * `bin/bridge-guard.mjs` cannot import this and keeps its own copy.
 */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}
