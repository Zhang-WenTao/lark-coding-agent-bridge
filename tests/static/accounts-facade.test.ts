import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

/**
 * The Claude account pool is split into accounts-{model,config,score,pool,report}.ts
 * behind one facade, src/agent/claude/accounts.ts. Code outside
 * src/agent/claude/ (and tests) must go through the facade, so the split
 * stays an internal detail that can move again without touching callers.
 */

const root = process.cwd();
const INTERNAL = /^src\/agent\/claude\/accounts-[a-z-]+\.ts$/;
const OWN_DIR = 'src/agent/claude/';

const collect = (path: string): string[] => {
  const full = join(root, path);
  if (statSync(full).isFile()) return /\.tsx?$/.test(path) && !path.endsWith('.d.ts') ? [path] : [];
  return readdirSync(full).flatMap((e) => collect(join(path, e))).sort();
};

const specifiers = (source: string): string[] =>
  [...source.matchAll(/(?:from|import\(|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!);

const target = (from: string, spec: string): string =>
  relative(root, join(root, normalize(join(dirname(from), spec.replace(/\.(js|ts)$/, ''))))) + '.ts';

describe('account pool facade', () => {
  it('only src/agent/claude/ imports the accounts-* internals', () => {
    const offenders: string[] = [];
    for (const file of [...collect('src'), ...collect('tests')]) {
      if (file.startsWith(OWN_DIR)) continue;
      for (const spec of specifiers(readFileSync(join(root, file), 'utf8'))) {
        const to = target(file, spec);
        if (INTERNAL.test(to)) offenders.push(`${file} -> ${to}`);
      }
    }
    expect(offenders, 'import from src/agent/claude/accounts instead').toEqual([]);
  });

  it('the internals exist (the pattern above still matches something)', () => {
    expect(collect(OWN_DIR).filter((f) => INTERNAL.test(f)).length).toBeGreaterThanOrEqual(5);
  });
});
