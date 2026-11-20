import { readFileSync } from 'node:fs';
import { removeSecret, setSecret } from '../../config/keystore';
import { writeFileAtomic } from '../../platform/atomic-write';
import { withFileLock } from '../../platform/file-lock';
import { type ClaudeAccountEntry, type ClaudeAccountsConfig, type ClaudeAccountsPaths, DEFAULT_ACCOUNT_ID, DEFAULT_LINES, type LineBoost, NICKNAME_MOODS, type NicknameMood, type Nicknames, type SwitchLines, WINDOW_KINDS, type WindowKind, accountSecretId, isPausedEntry, isValidAccountId, isValidLine, parseNicknames } from './accounts-model';

export function defaultAccountsConfig(): ClaudeAccountsConfig {
  return { lines: { ...DEFAULT_LINES }, accounts: [{ id: DEFAULT_ACCOUNT_ID }] };
}

/**
 * Tolerant parse: malformed entries are dropped, `default` is added in front
 * when missing.
 */
export function parseAccountsConfig(text: string): ClaudeAccountsConfig {
  const config = defaultAccountsConfig();
  let raw: { lines?: unknown; offDayLines?: unknown; offDayGraceHours?: unknown; accounts?: unknown; stagger?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return config;
  }
  if (!raw || typeof raw !== 'object') return config;
  config.lines = { ...config.lines, ...parseLines(raw.lines) };
  const offDay = parseLines(raw.offDayLines);
  if (Object.keys(offDay).length > 0) config.offDayLines = offDay;
  const offDayGrace = parseGraceHours(raw.offDayGraceHours);
  if (offDayGrace) config.offDayGraceHours = offDayGrace;
  if (raw.stagger === false) config.stagger = false;
  const accounts: ClaudeAccountEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!item || typeof item !== 'object') continue;
    const { id, label, lines, boost, pausedUntil, nicknames } = item as {
      id?: unknown;
      label?: unknown;
      nicknames?: unknown;
      lines?: unknown;
      boost?: unknown;
      pausedUntil?: unknown;
    };
    if (typeof id !== 'string' || !isValidAccountId(id) || seen.has(id)) continue;
    seen.add(id);
    const own = parseLines(lines);
    const raised = parseBoost(boost);
    const private_ = parseNicknames(nicknames);
    accounts.push({
      id,
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      ...(Object.keys(own).length > 0 ? { lines: own } : {}),
      ...(raised ? { boost: raised } : {}),
      ...(typeof pausedUntil === 'number' && Number.isFinite(pausedUntil) ? { pausedUntil } : {}),
      ...(private_ ? { nicknames: private_ } : {}),
    });
  }
  if (!seen.has(DEFAULT_ACCOUNT_ID)) accounts.unshift({ id: DEFAULT_ACCOUNT_ID });
  config.accounts = accounts;
  return config;
}

function isValidGraceHours(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 7 * 24;
}

function parseGraceHours(raw: unknown): Partial<Record<WindowKind, number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<WindowKind, number>> = {};
  for (const kind of WINDOW_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (isValidGraceHours(value)) out[kind] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseBoost(raw: unknown): ClaudeAccountEntry['boost'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const boost: Partial<Record<WindowKind, LineBoost>> = {};
  for (const kind of WINDOW_KINDS) {
    const value = (raw as Record<string, { line?: unknown; until?: unknown } | undefined>)[kind];
    if (value && isValidLine(value.line) && typeof value.until === 'number' && Number.isFinite(value.until)) {
      boost[kind] = { line: value.line, until: value.until };
    }
  }
  return Object.keys(boost).length > 0 ? boost : undefined;
}

function parseLines(raw: unknown): Partial<SwitchLines> {
  if (!raw || typeof raw !== 'object') return {};
  const lines: Partial<SwitchLines> = {};
  for (const kind of WINDOW_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (isValidLine(value)) lines[kind] = value;
  }
  return lines;
}

export function readAccountsConfig(paths: ClaudeAccountsPaths): ClaudeAccountsConfig {
  try {
    return parseAccountsConfig(readFileSync(paths.configFile, 'utf8'));
  } catch {
    return defaultAccountsConfig();
  }
}

async function writeAccountsConfig(paths: ClaudeAccountsPaths, config: ClaudeAccountsConfig): Promise<void> {
  await writeFileAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The file as it stands, for a change to it. Unlike {@link readAccountsConfig}
 * it never falls back to the default when the file is there but unreadable
 * or broken: writing that back would wipe every account. Only a missing file
 * starts from the default.
 */
function readAccountsConfigForWrite(paths: ClaudeAccountsPaths): ClaudeAccountsConfig {
  let text: string;
  try {
    text = readFileSync(paths.configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccountsConfig();
    throw err;
  }
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`账户配置 ${paths.configFile} 读不懂，没有改动它：${(err as Error).message}`);
  }
  return parseAccountsConfig(text);
}

/**
 * Read, change and write the accounts file under a lock shared with every
 * other process, so the daemon's own switches and `/account` commands cannot
 * undo each other. `change` returning `false` leaves the file as it was.
 */
export async function mutateAccountsConfig<T = ClaudeAccountsConfig>(
  paths: ClaudeAccountsPaths,
  change: (config: ClaudeAccountsConfig) => Promise<T | false> | T | false,
): Promise<{ config: ClaudeAccountsConfig; result: T | false }> {
  return withFileLock(paths.configFile, async () => {
    const config = readAccountsConfigForWrite(paths);
    const result = await change(config);
    if (result !== false) await writeAccountsConfig(paths, config);
    return { config, result };
  });
}

export interface AccountChanges {
  label?: string;
  /** Per window; `0` drops the account's own line (back to the profile's). */
  lines?: Partial<Record<WindowKind, number>>;
  /** Pause the account until then (epoch ms); `null` resumes it now. */
  pausedUntil?: number | null;
  /** The owner's private names, merged over any before; an empty name drops that mood, `null` drops them all. */
  nicknames?: Partial<Record<NicknameMood, string>> | null;
}

/** Add (or replace the token of) an account; new ones go last in the preference order. */
export async function saveAccount(
  paths: ClaudeAccountsPaths,
  account: { id: string; token: string } & AccountChanges,
): Promise<ClaudeAccountsConfig> {
  if (account.id === DEFAULT_ACCOUNT_ID) throw new Error('default 是 CLI 自己的登录，不能存令牌');
  if (!isValidAccountId(account.id)) throw new Error(`账号 id 只能用字母、数字、- 和 _（最长 32 位）：${account.id}`);
  const { config } = await mutateAccountsConfig(paths, async (config) => {
    if (!config.accounts.some((a) => a.id === account.id)) config.accounts.push({ id: account.id });
    applyAccountChanges(config, account.id, account);
    await setSecret(accountSecretId(account.id), account.token, paths.keystore);
  });
  return config;
}

/** Change an account's name or lines without touching its token. */
export async function updateAccount(
  paths: ClaudeAccountsPaths,
  id: string,
  changes: AccountChanges,
): Promise<ClaudeAccountsConfig> {
  const { config } = await mutateAccountsConfig(paths, (config) => {
    if (!config.accounts.some((a) => a.id === id)) throw new Error(`没有账户 ${id}`);
    applyAccountChanges(config, id, changes);
  });
  return config;
}

/** The profile's lines, for every account without its own. */
export async function updateDefaultLines(
  paths: ClaudeAccountsPaths,
  lines: Partial<SwitchLines>,
): Promise<ClaudeAccountsConfig> {
  const { config } = await mutateAccountsConfig(paths, (config) => {
    for (const kind of WINDOW_KINDS) {
      const value = lines[kind];
      if (value === undefined) continue;
      if (!isValidLine(value)) throw new Error(`切换线要在 1–100 之间：${value}`);
      config.lines[kind] = value;
    }
  });
  return config;
}

/** Rest-day lines for every account; `0` drops a window's (it keeps the usual lines on rest days). */
export async function updateOffDayLines(
  paths: ClaudeAccountsPaths,
  lines: Partial<Record<WindowKind, number>>,
  graceHours: Partial<Record<WindowKind, number>> = {},
): Promise<ClaudeAccountsConfig> {
  const { config } = await mutateAccountsConfig(paths, (config) => {
    const grace: Partial<Record<WindowKind, number>> = { ...config.offDayGraceHours };
    for (const kind of WINDOW_KINDS) {
      const value = graceHours[kind];
      if (value === undefined) continue;
      if (value === 0) delete grace[kind];
      else if (!isValidGraceHours(value)) throw new Error(`临近重置时长要在 0–168 小时之间：${value}`);
      else grace[kind] = value;
    }
    if (Object.keys(grace).length > 0) config.offDayGraceHours = grace;
    else delete config.offDayGraceHours;
    const next: Partial<SwitchLines> = { ...config.offDayLines };
    for (const kind of WINDOW_KINDS) {
      const value = lines[kind];
      if (value === undefined) continue;
      if (value === 0) delete next[kind];
      else if (!isValidLine(value)) throw new Error(`切换线要在 1–100 之间：${value}`);
      else next[kind] = value;
    }
    if (Object.keys(next).length > 0) config.offDayLines = next;
    else delete config.offDayLines;
  });
  return config;
}

/** Put the named accounts first, in the order given; the rest keep their order after them. */
/** Turn the 5-hour window stagger on or off for the profile. */
export async function updateStagger(paths: ClaudeAccountsPaths, enabled: boolean): Promise<ClaudeAccountsConfig> {
  const { config } = await mutateAccountsConfig(paths, (config) => {
    if (enabled) delete config.stagger;
    else config.stagger = false;
  });
  return config;
}

export async function reorderAccounts(paths: ClaudeAccountsPaths, ids: string[]): Promise<ClaudeAccountsConfig> {
  const { config } = await mutateAccountsConfig(paths, (config) => {
    const known = new Set(config.accounts.map((a) => a.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`没有账户：${unknown.join(', ')}`);
    if (new Set(ids).size !== ids.length) throw new Error('账户重复了');
    const first = ids.map((id) => config.accounts.find((a) => a.id === id)!);
    config.accounts = [...first, ...config.accounts.filter((a) => !ids.includes(a.id))];
    // Raised lines belong to the main account alone.
    for (const entry of config.accounts.slice(1)) delete entry.boost;
  });
  return config;
}

function applyAccountChanges(config: ClaudeAccountsConfig, id: string, changes: AccountChanges): void {
  const entry = config.accounts.find((a) => a.id === id)!;
  const label = changes.label?.trim();
  if (label) entry.label = label;
  if (changes.nicknames === null) delete entry.nicknames;
  else if (changes.nicknames) {
    const merged: Nicknames = { ...entry.nicknames };
    for (const mood of NICKNAME_MOODS) {
      const value = changes.nicknames[mood];
      if (value === undefined) continue;
      if (value.trim()) merged[mood] = value.trim();
      else delete merged[mood];
    }
    if (Object.keys(merged).length > 0) entry.nicknames = merged;
    else delete entry.nicknames;
  }
  for (const kind of WINDOW_KINDS) {
    const value = changes.lines?.[kind];
    if (value === undefined) continue;
    if (value === 0) {
      if (entry.lines) delete entry.lines[kind];
    } else if (isValidLine(value)) {
      entry.lines = { ...entry.lines, [kind]: value };
    } else {
      throw new Error(`切换线要在 1–100 之间（0 表示跟默认）：${value}`);
    }
  }
  if (entry.lines && Object.keys(entry.lines).length === 0) delete entry.lines;
  if (changes.pausedUntil === null) {
    delete entry.pausedUntil;
  } else if (changes.pausedUntil !== undefined) {
    if (!Number.isFinite(changes.pausedUntil)) throw new Error(`暂停截止时间无效：${changes.pausedUntil}`);
    // Some account has to stay in rotation, or every run would fail to start.
    const now = Date.now();
    if (!config.accounts.some((a) => a.id !== id && !isPausedEntry(a, now))) {
      throw new Error('至少要留一个没暂停的账户');
    }
    entry.pausedUntil = changes.pausedUntil;
  }
}

export async function deleteAccount(paths: ClaudeAccountsPaths, id: string): Promise<boolean> {
  if (id === DEFAULT_ACCOUNT_ID) throw new Error('default 是 CLI 自己的登录，不能删除');
  const { result: removedEntry } = await mutateAccountsConfig(paths, (config) => {
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((a) => a.id !== id);
    return config.accounts.length !== before;
  });
  const removedSecret = await removeSecret(accountSecretId(id), paths.keystore).catch(() => false);
  return removedSecret || removedEntry === true;
}

/**
 * Make `id` the main account: new runs use it first; the rest keep their
 * order. Any raised lines end here; `boost` raises the new main account's.
 */
export async function switchToAccount(
  paths: ClaudeAccountsPaths,
  id: string,
  boost?: ClaudeAccountEntry['boost'],
): Promise<ClaudeAccountsConfig> {
  const { config } = await mutateAccountsConfig(paths, (config) => {
    if (!config.accounts.some((a) => a.id === id)) throw new Error(`没有账户：${id}`);
    config.accounts = withMain(config.accounts, id);
    if (boost && Object.keys(boost).length > 0) config.accounts[0]!.boost = boost;
  });
  return config;
}

/** `id` first, the rest in order, nobody's lines raised. */
export function withMain(accounts: ClaudeAccountEntry[], id: string): ClaudeAccountEntry[] {
  const plain = accounts.map(({ boost: _raised, ...entry }) => entry);
  return [...plain.filter((a) => a.id === id), ...plain.filter((a) => a.id !== id)];
}
