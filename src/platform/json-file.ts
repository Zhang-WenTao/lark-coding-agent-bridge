import { readFile, rename } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-write';

/** A state file that could not be parsed at load and was moved aside. */
export interface LoadProblem {
  path: string;
  movedTo: string;
  error: string;
}

export interface JsonFileOptions {
  /** File mode for writes (default 0600, as {@link writeFileAtomic}). */
  mode?: number;
  /**
   * The file exists but could not be used: unreadable, or not valid JSON.
   * When it was not valid JSON (`kind: 'parse'`) it has already been renamed
   * to `movedTo`, so the next write cannot overwrite the only copy; `movedTo`
   * is unset if that rename failed.
   */
  onLoadError: (err: unknown, movedTo?: string, kind?: 'read' | 'parse') => void;
  /** A queued write failed; later writes still run. */
  onPersistError: (err: unknown) => void;
  /** Clock for the `.corrupt-<ts>` suffix (tests). */
  now?: () => number;
}

/**
 * The persistence half every JSON state store repeats: read-and-parse on load
 * (a missing file is simply "no state yet"), and a single write chain so
 * writes land in the order they were queued, each one atomic.
 *
 * Stores keep their own in-memory shape, validation and log events; this only
 * owns the file. Passing no path makes it memory-only (every call is a no-op).
 */
export class JsonFile {
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string | undefined,
    private readonly opts: JsonFileOptions,
  ) {}

  /** Parsed contents, or `undefined` when there is no file or it was unusable (already reported). */
  async load(): Promise<unknown> {
    if (!this.path) return undefined;
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.onLoadError(err, undefined, 'read');
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      this.opts.onLoadError(err, await this.moveAside(this.path), 'parse');
      return undefined;
    }
  }

  /** Queue `text` to be written after every earlier write. */
  write(text: string): void {
    const path = this.path;
    if (!path) return;
    this.saving = this.saving
      .then(() => writeFileAtomic(path, text, this.opts.mode === undefined ? {} : { mode: this.opts.mode }))
      .catch((err: unknown) => this.opts.onPersistError(err));
  }

  /** Resolves once every write queued so far has landed. */
  flush(): Promise<void> {
    return this.saving;
  }

  private async moveAside(path: string): Promise<string | undefined> {
    const target = `${path}.corrupt-${(this.opts.now ?? Date.now)()}`;
    try {
      await rename(path, target);
      return target;
    } catch {
      return undefined;
    }
  }
}
