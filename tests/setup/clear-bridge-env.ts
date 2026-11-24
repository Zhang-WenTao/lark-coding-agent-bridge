// The bridge exports these into every agent it spawns, so running the suite
// from a bridge-spawned shell would otherwise leak the live profile into tests
// (e.g. LARK_CHANNEL_PROFILE pinning secret lookups to a profile that doesn't
// exist in a temp root). Tests that need them stub them explicitly.
for (const key of [
  'LARK_CHANNEL',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_CONFIG',
  'LARKSUITE_CLI_CONFIG_DIR',
]) {
  delete process.env[key];
}

// Every batch writes a run-context file (src/bot/run-context.ts); keep the
// suite's out of the live ~/.lark-channel/run-context.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.LARK_CHANNEL_RUN_CONTEXT_DIR = mkdtempSync(join(tmpdir(), 'run-context-'));
