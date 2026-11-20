import { paths } from '../config/paths';
import { log } from '../core/logger';
import { JsonFile, type LoadProblem } from '../platform/json-file';

export interface ManagedWorktree {
  repoRoot: string;
  path: string;
  branch: string;
  /** Only branches created by bridge may be deleted automatically. */
  ownedBranch: boolean;
  lastUsedAt: number;
}

interface WorkspaceData {
  chats: Record<string, { cwd: string }>;
  named: Record<string, string>;
  managedWorktrees?: ManagedWorktree[];
}

export class WorkspaceStore {
  private data: WorkspaceData = { chats: {}, named: {} };
  private readonly file: JsonFile;
  private loadProblem: LoadProblem | undefined;

  constructor(path: string = paths.workspacesFile) {
    this.file = new JsonFile(path, {
      mode: 0o600,
      // Unparseable JSON has been moved aside: start empty and let the owner
      // know. Anything else (unreadable, or the move failed) still refuses to
      // start, since writing now would replace the only copy.
      onLoadError: (err, movedTo) => {
        if (!movedTo) throw err;
        log.fail('workspace', err, { step: 'load', movedTo });
        this.loadProblem = { path, movedTo, error: String(err) };
      },
      onPersistError: (err) => log.fail('workspace', err, { step: 'persist' }),
    });
  }

  /** The unparseable file found at load, if any; cleared once read. */
  takeLoadProblem(): LoadProblem | undefined {
    const problem = this.loadProblem;
    this.loadProblem = undefined;
    return problem;
  }

  async load(): Promise<void> {
    const loaded = await this.file.load();
    if (loaded === undefined) return;
    const parsed = loaded as Partial<WorkspaceData>;
    this.data = {
      chats: parsed.chats ?? {},
      named: parsed.named ?? {},
      managedWorktrees: parsed.managedWorktrees ?? [],
    };
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.touchWorktree(this.data.chats[chatId]?.cwd);
    this.touchWorktree(cwd);
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
  }

  removeCwd(chatId: string): boolean {
    if (!(chatId in this.data.chats)) return false;
    this.touchWorktree(this.data.chats[chatId]?.cwd);
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }

  listCwds(prefix?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.data.chats)) {
      if (prefix && !key.startsWith(prefix)) continue;
      out[key] = value.cwd;
    }
    return out;
  }

  listNamed(): Record<string, string> {
    return { ...this.data.named };
  }

  getNamed(name: string): string | undefined {
    return this.data.named[name];
  }

  saveNamed(name: string, cwd: string): void {
    this.data.named[name] = cwd;
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    if (!(name in this.data.named)) return false;
    delete this.data.named[name];
    this.schedulePersist();
    return true;
  }

  trackWorktree(entry: Omit<ManagedWorktree, 'lastUsedAt'>, now = Date.now()): void {
    this.data.managedWorktrees = [...this.listManagedWorktrees().filter(e => e.path !== entry.path), { ...entry, lastUsedAt: now }];
    this.schedulePersist();
  }

  listManagedWorktrees(): ManagedWorktree[] {
    return (this.data.managedWorktrees ?? []).map(e => ({ ...e }));
  }

  touchWorktree(cwd: string | undefined, now = Date.now()): void {
    if (!cwd) return;
    const entry = this.data.managedWorktrees?.find(e => e.path === cwd);
    if (entry) { entry.lastUsedAt = now; this.schedulePersist(); }
  }

  forgetWorktree(path: string): void {
    this.data.managedWorktrees = this.listManagedWorktrees().filter(e => e.path !== path);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }

  private schedulePersist(): void {
    this.file.write(`${JSON.stringify(this.data, null, 2)}
`);
  }
}
