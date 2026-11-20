import { log } from '../core/logger';
import { JsonFile } from '../platform/json-file';

type NonceState = 'used' | 'revoked';

export class CallbackNonceStore {
  private readonly nonces = new Map<string, NonceState>();
  private readonly file: JsonFile;

  constructor(path: string) {
    this.file = new JsonFile(path, {
      mode: 0o600,
      onLoadError: (err, movedTo) => log.fail('callback-nonce', err, { step: 'load', movedTo }),
      onPersistError: (err) => log.fail('callback-nonce', err, { step: 'persist' }),
    });
  }

  async load(): Promise<void> {
    const raw = await this.file.load();
    if (!raw || typeof raw !== 'object') return;
    this.nonces.clear();
    for (const [nonce, state] of Object.entries(raw as Record<string, unknown>)) {
      if (state === 'used' || state === 'revoked') this.nonces.set(nonce, state);
    }
  }

  state(nonce: string): NonceState | undefined {
    return this.nonces.get(nonce);
  }

  consume(nonce: string): boolean {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, 'used');
    this.schedulePersist();
    return true;
  }

  revoke(nonce: string): void {
    this.nonces.set(nonce, 'revoked');
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private schedulePersist(): void {
    this.file.write(`${JSON.stringify(Object.fromEntries(this.nonces), null, 2)}\n`);
  }
}
