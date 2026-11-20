import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

/**
 * Layering contract (docs/progress/bridge-refactor-analysis.md §1.2).
 * Dependencies may only point to the same or a lower layer:
 *
 *   L6 entry       app/ cli/ ui/ daemon/ terminal/ index.ts
 *   L5 IM          bot/
 *   L4 features    commands/ scheduler/ meeting/ dream/ card/
 *   L3 runtime     runtime/
 *   L2 capability  agent/ knowledge/ lark-cli/ media/
 *   L1 state       config/ session/ workspace/ policy/ git/
 *   L0 base        core/ platform/ utils/ events/ observability/
 *
 * Only value imports count (`import type` is erased at runtime). Existing
 * upward edges are listed in KNOWN_UPWARD below; that list may only shrink:
 * a new upward edge fails the first test, and an edge that no longer exists
 * fails the second one until it is removed from the list.
 */

const root = process.cwd();

const LAYER_BY_DIR: Record<string, number> = {
  app: 6, cli: 6, ui: 6, daemon: 6, terminal: 6,
  bot: 5,
  commands: 4, scheduler: 4, meeting: 4, dream: 4, card: 4,
  runtime: 3,
  agent: 2, knowledge: 2, 'lark-cli': 2, media: 2,
  config: 1, session: 1, workspace: 1, policy: 1, git: 1,
  core: 0, platform: 0, utils: 0, events: 0, observability: 0,
};

const LAYER_BY_FILE: Record<string, number> = {
  'src/index.ts': 6,
};

const layerOf = (file: string): number => {
  if (file in LAYER_BY_FILE) return LAYER_BY_FILE[file]!;
  const dir = file.split('/')[1]!;
  const layer = LAYER_BY_DIR[dir];
  if (layer === undefined) throw new Error(`no layer assigned to src/${dir}/ (add it to LAYER_BY_DIR)`);
  return layer;
};

const collectTsFiles = (path: string): string[] => {
  const full = join(root, path);
  if (statSync(full).isFile()) return /\.tsx?$/.test(path) && !path.endsWith('.d.ts') ? [path] : [];
  return readdirSync(full).flatMap((e) => collectTsFiles(join(path, e))).sort();
};

const resolveImport = (from: string, spec: string): string | null => {
  const base = normalize(join(dirname(from), spec.replace(/\.(js|ts)$/, '')));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(join(root, candidate))) return relative(root, join(root, candidate));
  }
  return null;
};

// Value imports and re-exports with a relative specifier; `import type` /
// `export type` are skipped. Dynamic `import('...')` counts as a value edge.
const VALUE_IMPORT = /(?:^|\n)\s*(?:import(?!\s+type\b)[^'";]*?from\s*|import\s*|export(?!\s+type\b)[^'";]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const DYNAMIC_IMPORT = /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

const upwardEdges = (): string[] => {
  const edges = new Set<string>();
  for (const file of collectTsFiles('src')) {
    const text = readFileSync(join(root, file), 'utf8');
    const specs = [...text.matchAll(VALUE_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]!);
    for (const spec of specs) {
      const target = resolveImport(file, spec);
      if (!target || !target.startsWith('src/')) continue;
      if (layerOf(target) > layerOf(file)) edges.add(`${file} -> ${target}`);
    }
  }
  return [...edges].sort();
};

// Upward value edges that existed when the contract was introduced
// (refactor stage 7). Remove entries as they get fixed; never add new ones.
const KNOWN_UPWARD: string[] = [
  'src/agent/codex/adapter.ts -> src/runtime/errors.ts',
  'src/agent/codex/app-server-run.ts -> src/runtime/approvals.ts',
  'src/commands/handlers/access.ts -> src/bot/lark-info.ts',
  'src/commands/handlers/config.ts -> src/bot/app-scope.ts',
  'src/commands/handlers/config.ts -> src/bot/lark-info.ts',
  'src/commands/handlers/config.ts -> src/bot/wizard.ts',
  'src/commands/handlers/config.ts -> src/ui/sidecar.ts',
  'src/commands/handlers/lifecycle.ts -> src/bot/auto-resume.ts',
  'src/commands/handlers/status.ts -> src/bot/auto-resume.ts',
  'src/commands/handlers/status.ts -> src/bot/run-status.ts',
  'src/commands/handlers/workspace.ts -> src/bot/group.ts',
  'src/config/config-ops.ts -> src/lark-cli/identity-policy.ts',
  'src/config/profile-schema.ts -> src/agent/registry.ts',
  'src/config/profile-store.ts -> src/agent/registry.ts',
  'src/knowledge/exposure.ts -> src/runtime/usage-ledger.ts',
  'src/meeting/orchestrator.ts -> src/bot/run-flow.ts',
  'src/scheduler/runner.ts -> src/bot/agent-stream.ts',
  'src/scheduler/runner.ts -> src/bot/run-flow.ts',
  'src/session/catalog.ts -> src/agent/registry.ts',
  'src/session/smart-session.ts -> src/agent/prompt.ts',
];

describe('layering contract', () => {
  const actual = upwardEdges();

  it('introduces no new upward dependency', () => {
    const fresh = actual.filter((e) => !KNOWN_UPWARD.includes(e));
    expect(fresh, 'new upward import(s); depend downwards or move the shared code to a lower layer').toEqual([]);
  });

  it('keeps the known-upward list in sync (it may only shrink)', () => {
    const stale = KNOWN_UPWARD.filter((e) => !actual.includes(e));
    expect(stale, 'these edges are gone; delete them from KNOWN_UPWARD').toEqual([]);
  });
});
