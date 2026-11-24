import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Who started the current turn and from where, for tools the agent runs
 * (e.g. the device-command script's ledger). The bridge rewrites the file on
 * every batch, so a process kept alive across turns still reads the current
 * sender; the agent learns its path from `LARK_CHANNEL_RUN_CONTEXT` and never
 * has to (and should not) fill these facts in itself.
 */
export interface RunContext {
  scope: string;
  chatId: string;
  /** p2p = private chat (Alice's entry lands here too), group, or a topic. */
  mode: 'p2p' | 'group' | 'topic';
  threadId?: string;
  chatName?: string;
  senders: { openId: string; name?: string; type?: 'user' | 'bot' }[];
  ownerRun: boolean;
  /** A private chat with someone other than the owner (`access.publicDm`). */
  publicDm: boolean;
  messageIds: string[];
  updatedAt: string;
}

/** Tests point this elsewhere (tests/setup) so a suite run never writes the live profile's files. */
function runContextDir(appDir: string): string {
  return process.env.LARK_CHANNEL_RUN_CONTEXT_DIR || join(appDir, 'run-context');
}

export function runContextPath(appDir: string, scope: string): string {
  const name = createHash('sha1').update(scope).digest('hex').slice(0, 16);
  return join(runContextDir(appDir), `${name}.json`);
}

/** Write atomically; returns the path, or undefined when the write failed. */
export function writeRunContext(appDir: string, ctx: RunContext): string | undefined {
  const path = runContextPath(appDir, ctx.scope);
  try {
    mkdirSync(runContextDir(appDir), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ctx, null, 2), 'utf8');
    renameSync(tmp, path);
    return path;
  } catch {
    return undefined;
  }
}
