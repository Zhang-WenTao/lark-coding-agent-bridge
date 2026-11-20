import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import { JsonFile } from '../platform/json-file';

/** One scope's queued messages, as written to disk. */
export interface PendingRecord {
  scope: string;
  /** When the oldest message in the batch was queued. */
  queuedAt: number;
  messages: NormalizedMessage[];
}

type PendingMap = Record<string, PendingRecord>;

function isPendingRecord(x: unknown): x is PendingRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<PendingRecord>;
  return (
    typeof r.scope === 'string' &&
    typeof r.queuedAt === 'number' &&
    Array.isArray(r.messages) &&
    r.messages.every((m) => m && typeof m === 'object' && typeof (m as { chatId?: unknown }).chatId === 'string')
  );
}

/**
 * Durable copy of the IM pending queue, so messages waiting behind a run
 * survive a restart, reconnect or crash. The in-memory queue stays the source
 * of truth while the process lives; this file only matters to the next one.
 */
export class PendingStore {
  private data: PendingMap = {};
  private readonly file: JsonFile;

  constructor(path: string) {
    this.file = new JsonFile(path, {
      mode: 0o600,
      onLoadError: (err, movedTo) => log.warn('pending-store', 'load-failed', { err: String(err), movedTo }),
      onPersistError: (err) => log.warn('pending-store', 'persist-failed', { err: String(err) }),
    });
  }

  async load(): Promise<void> {
    const raw = await this.file.load();
    if (raw === undefined) return;
    this.data = {};
    if (!raw || typeof raw !== 'object') return;
    for (const [scope, entry] of Object.entries(raw)) {
      if (isPendingRecord(entry) && entry.messages.length > 0) this.data[scope] = entry;
    }
  }

  /** Replace a scope's queued messages; an empty list removes the scope. */
  set(scope: string, messages: readonly NormalizedMessage[], now: number = Date.now()): void {
    if (messages.length === 0) {
      if (!(scope in this.data)) return;
      delete this.data[scope];
    } else {
      this.data[scope] = { scope, queuedAt: this.data[scope]?.queuedAt ?? now, messages: [...messages] };
    }
    this.schedulePersist();
  }

  /** Everything left by a previous process; removed as it is returned. */
  takeAll(): PendingRecord[] {
    const records = Object.values(this.data);
    if (records.length === 0) return [];
    this.data = {};
    this.schedulePersist();
    return records;
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private schedulePersist(): void {
    this.file.write(JSON.stringify(this.data));
  }
}
