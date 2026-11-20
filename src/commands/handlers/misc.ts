import { coffeeCard } from '../../card/templates';
import { log } from '../../core/logger';
import { codeBlockPost } from '../../card/code-snippets';
import type { CommandContext } from '../types';
import { commandReplyOptions, reply } from '../shared';

/**
 * 「复制代码」 button on a finished card: send that code block alone as a
 * reply to the card. It goes out as a rich-text code block, whose copy icon
 * copies it whole (cards can't write the clipboard, and their own code blocks
 * have no copy icon); code that itself holds a ``` fence goes out as plain
 * text instead. Args: `<key> [lang]`; cards from before the language rode
 * along carry only the key.
 */
export async function handleCopyCode(args: string, ctx: CommandContext): Promise<void> {
  const [key = '', lang = ''] = args.trim().split(/\s+/);
  const code = key ? ctx.controls.codeSnippets?.get(key) : undefined;
  if (!code) {
    await reply(ctx, '这段代码已经找不到了（太久以前的卡片），请让我重新发一次。');
    return;
  }
  const post = codeBlockPost(code, lang);
  log.info('command', 'copycode', { key, chars: code.length, as: post ? 'code-block' : 'text' });
  try {
    await ctx.channel.send(ctx.msg.chatId, post ? { post } : { text: code }, commandReplyOptions(ctx));
  } catch (err) {
    log.fail('command', err, { step: 'copycode' });
    await reply(ctx, '代码发送失败，请稍后再点一次。');
  }
}

export async function handleCoffee(_args: string, ctx: CommandContext): Promise<void> {
  await ctx.channel.send(ctx.msg.chatId, { card: coffeeCard() }, commandReplyOptions(ctx));
}

// ─── git: /diff, /worktree, /pr ───────────────────────────────────────────
