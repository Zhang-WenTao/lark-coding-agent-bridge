import { basename } from 'node:path';
import { fireAndForget } from '../core/fire-and-forget';
import { log } from '../core/logger';
import type { LoadProblem } from '../platform/json-file';

interface NoticeSender {
  send(to: string, content: { markdown: string }): Promise<unknown>;
}

/** Owner DM text for one state file that was moved aside at start-up. */
export function corruptStateNotice(problem: LoadProblem): string {
  return [
    `⚠️ 启动时 \`${basename(problem.path)}\` 解析失败，已改名保留为：`,
    `\`${problem.movedTo}\``,
    '本次按空状态启动（这份文件记录的续聊会话或工作目录绑定已清空），bot 照常可用。',
    '需要找回时，停掉 bridge 后人工核对、修好这份备份，再改回原文件名。',
    `解析错误：${problem.error}`,
  ].join('\n');
}

/**
 * Tell the owner, by DM, about state files {@link JsonFile} moved aside at load.
 * Without a known owner it is only logged (the move itself is already in the log).
 */
export function notifyCorruptStateFiles(
  sender: NoticeSender,
  ownerId: string | undefined,
  problems: ReadonlyArray<LoadProblem | undefined>,
): void {
  for (const problem of problems) {
    if (!problem) continue;
    if (!ownerId) {
      log.warn('store', 'corrupt-notice-no-owner', { path: problem.path, movedTo: problem.movedTo });
      continue;
    }
    fireAndForget(sender.send(ownerId, { markdown: corruptStateNotice(problem) }), 'store', {
      step: 'corrupt-notice',
      path: problem.path,
    });
  }
}
