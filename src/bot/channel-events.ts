import type { LarkChannel } from '@larksuite/channel';
import { log, reportMetric, withTrace } from '../core/logger';
import { EDIT_EVENT, parseEditEvent, type EditEvent } from './edit';
import { parseRecallEvent, RECALL_EVENT, type RecallEvent } from './recall';

type EventHandlers = Parameters<LarkChannel['on']>[0];
type Arg<K extends keyof EventHandlers> = Parameters<NonNullable<EventHandlers[K]>>[0];

/**
 * What each incoming event turns into. `startChannel` builds these closures
 * over its own state, so this module never imports `channel.ts` back.
 */
export interface ChannelEventSinks {
  message(msg: Arg<'message'>): Promise<void>;
  cardAction(evt: Arg<'cardAction'>): Promise<void>;
  comment(evt: Arg<'comment'>): Promise<void>;
  /** Returns the fields to log under `recall.<action>`. */
  recall(evt: RecallEvent): { action: string } & Record<string, unknown>;
  edit(evt: EditEvent): Promise<void>;
}

/**
 * Wires the SDK's events and the raw recall / edit events to `sinks`:
 * tracing, error logging, reconnect escalation and WS error classification
 * live here; what a message *does* stays in `channel.ts`.
 */
export function registerChannelEvents(channel: LarkChannel, sinks: ChannelEventSinks): void {
  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () => sinks.message(msg)).catch((err) =>
        log.fail('intake', err),
      );
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await sinks.cardAction(evt);
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await sinks.comment(evt).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  // 撤回消息: rides the existing connection like the meeting events
  // (a second long connection would split delivery). Only arrives once the
  // app subscribes to "消息被撤回" in the developer console.
  if (typeof channel.onRawEvent !== 'function') {
    log.warn('recall', 'hook-unavailable', { reason: 'channel 不支持 onRawEvent' });
    return;
  }
  channel.onRawEvent(RECALL_EVENT, (raw) => {
    const evt = parseRecallEvent(raw);
    if (!evt) {
      log.warn('recall', 'unparsed', {});
      return;
    }
    const { action, ...fields } = sinks.recall(evt);
    log.info('recall', action, fields);
  });

  // 消息被编辑: rides the same connection as the recall events above, and
  // likewise only arrives once the app subscribes to "消息被编辑" in the
  // developer console.
  channel.onRawEvent(EDIT_EVENT, async (raw) => {
    const evt = parseEditEvent(raw);
    if (!evt) {
      log.warn('edit', 'unparsed', {});
      return;
    }
    await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, () => sinks.edit(evt)).catch((err) =>
      log.fail('edit', err),
    );
  });
}
