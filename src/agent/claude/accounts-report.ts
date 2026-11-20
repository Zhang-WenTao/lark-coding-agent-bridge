import { formatMonthDayTime } from '../../core/time-format';
import { type AccountNameView, type ClaudeAccountEntry, DEFAULT_ACCOUNT_ID, FABLE_WINDOW, GRACE_LINE, type LineBoost, type NicknameMood, WINDOW_KINDS, WINDOW_LABELS, type WindowKind, nicknameOf } from './accounts-model';
import { ClaudeAccountPool } from './accounts-pool';
import { type AccountRow, type AccountWindowView, STICKY_MARGIN, WINDOW_MS, WORTH_MOVING_ROOM, switchScore, windowsKnown } from './accounts-score';

/**
 * The accounts as Markdown lines for `/usage` and the CLI: which one new runs
 * go to (▶), each one's lines, how full it is by its last report, and whether
 * it is past a line or refused. `defaultLabel` names the CLI's own login.
 */
export function accountsReport(
  pool: ClaudeAccountPool,
  defaultLabel: string | undefined,
  now = Date.now(),
  view: AccountNameView = {},
): string[] {
  const next = pool.pick()?.id;
  const paused = pool
    .pausedAccounts()
    .map(
      ({ account, until }) =>
        `- **${displayName(account, defaultLabel, view, 'sad')}**（已暂停，${account.id}；切换线 5h ${pool.lineOf(account.id, 'five_hour')}% · 周 ${pool.lineOf(account.id, 'seven_day')}%）：⏸ 暂停到 ${formatMonthDayTime(until)}，到期自动恢复`,
    );
  const active = pool.status().map(({ account, state }, index) => {
    const refusedAt = pool.refusedUntil(account.id, now);
    const name = displayName(
      account,
      defaultLabel,
      view,
      refusedAt !== undefined ? 'sad' : account.id === next ? 'excited' : pool.pastLine(account.id, now) ? 'wronged' : 'happy',
    );
    const marker = account.id === next ? '▶ ' : '';
    const role = index === 0 ? '主账户' : `备用 ${index}`;
    const lines = `切换线 5h ${pool.lineOf(account.id, 'five_hour')}% · 周 ${pool.lineOf(account.id, 'seven_day')}%`;
    const usage =
      WINDOW_KINDS.map((kind) => {
        const window = state?.windows[kind];
        if (!window) return undefined;
        const used = window.resetsAt !== undefined && window.resetsAt <= now ? 0 : window.usedPercent;
        return `${WINDOW_LABELS[kind]} ${Math.round(used)}%`;
      })
        .filter((part): part is string => part !== undefined)
        .join(' · ') || '还没有运行记录';
    const fable = pool.windowUsed(account.id, FABLE_WINDOW, now);
    const fablePart = fable !== undefined ? ` · 本周 Fable ${Math.round(fable)}%` : '';
    const refused = pool.refusedUntil(account.id, now);
    const past = pool.pastLine(account.id, now);
    const flag =
      refused !== undefined
        ? ` · ⛔ 额度用尽，${formatMonthDayTime(refused)} 恢复`
        : past
          ? ` · ⚠️ 已过${WINDOW_LABELS[past.kind]}切换线，其他账户也到线后才轮到它`
          : '';
    return `- ${marker}**${name}**（${role}，${account.id}；${lines}）：${usage}${fablePart}${flag}`;
  });
  return [...active, ...paused];
}

/**
 * `🏖 休息日（周末和法定节假日）…` — the rest-day rules and whether they are in
 * force now; undefined when none are set.
 */
export function offDayNote(pool: ClaudeAccountPool, now = Date.now()): string | undefined {
  const lines = pool.offDayLines;
  const grace = pool.offDayGraceHours;
  if (!lines && !grace) return undefined;
  const parts: string[] = [];
  if (lines) {
    const each = WINDOW_KINDS.filter((kind) => lines[kind] !== undefined).map((kind) => `${WINDOW_LABELS[kind]} ${lines[kind]}%`);
    parts.push(`切换线至少 ${each.join(' · ')}`);
  }
  if (grace) {
    const each = WINDOW_KINDS.filter((kind) => grace[kind] !== undefined).map(
      (kind) => `${WINDOW_LABELS[kind]}重置前 ${grace[kind]} 小时`,
    );
    parts.push(`临近重置放开到 ${GRACE_LINE}% 并优先使用：${each.join(' · ')}`);
  }
  const active = pool.offDayLinesActive(now) ? '今天是休息日，正在生效' : '今天是工作日，未生效';
  return `🏖 休息日（周末和法定节假日，调休上班日除外）：${parts.join('；')}（${active}）`;
}

/** `⏸ 已暂停：Mia（backup2）到 11-13 00:00 …` under the `/accounts` table; undefined when none is paused. */
export function pausedNote(pool: ClaudeAccountPool, view: AccountNameView = {}): string | undefined {
  const paused = pool.pausedAccounts();
  if (paused.length === 0) return undefined;
  const names = paused.map(({ account, until }) => `${displayName(account, undefined, view, 'sad')}（${account.id}）到 ${formatMonthDayTime(until)}`);
  return `⏸ 已暂停：${names.join('、')}，期间不参与选号，到期自动恢复。`;
}

/** A paused account by id or label, ignoring case: why a switch by name may not go to it. */
export function findPausedAccount(
  pool: ClaudeAccountPool,
  query: string,
  view: AccountNameView = {},
): { id: string; name: string; until: number } | undefined {
  const q = query.trim().toLowerCase();
  const hit = pool
    .pausedAccounts()
    .find(
      ({ account }) =>
        account.id.toLowerCase() === q ||
        account.label?.toLowerCase() === q ||
        (view.private && Object.values(account.nicknames ?? {}).some((n) => n.toLowerCase() === q)),
    );
  return hit ? { id: hit.account.id, name: displayName(hit.account, undefined, view, 'sad'), until: hit.until } : undefined;
}

/** `已暂停到 11-13 00:00` — the reason a switch by name does not go to a paused account. */
export function pausedRefusal(until: number): string {
  return `已暂停到 ${formatMonthDayTime(until)}，到期自动恢复`;
}

/** The name an account goes by: its label (for `default` without one, the CLI login's name), or today's private name for the owner. */
function displayName(
  account: Pick<ClaudeAccountEntry, 'id' | 'label' | 'nicknames'>,
  defaultLabel: string | undefined,
  view: AccountNameView,
  mood: NicknameMood,
): string {
  const nickname = view.private ? nicknameOf(account, mood) : undefined;
  if (nickname) return nickname;
  if (account.label) return account.label;
  return account.id === DEFAULT_ACCOUNT_ID ? (defaultLabel ?? 'CLI 登录') : account.id;
}

/** Every account with its usage, resets, lines, state and switch score, in preference order. */
export function accountRows(
  pool: ClaudeAccountPool,
  defaultLabel: string | undefined,
  now = Date.now(),
  view: AccountNameView = {},
): AccountRow[] {
  const next = pool.pick()?.id;
  return pool.accounts().map((account, index) => {
    const windows = pool.windowViews(account.id, now);
    const known = windowsKnown(windows);
    const refusedUntil = pool.refusedUntil(account.id, now);
    const pastLine = pool.pastLine(account.id, now)?.kind;
    return {
      id: account.id,
      name: displayName(
        account,
        defaultLabel,
        view,
        refusedUntil !== undefined ? 'sad' : account.id === next ? 'excited' : pastLine ? 'wronged' : 'happy',
      ),
      aliases: [
        account.label,
        account.id === DEFAULT_ACCOUNT_ID ? defaultLabel : undefined,
        ...(view.private ? Object.values(account.nicknames ?? {}) : []),
      ].filter((n): n is string => Boolean(n)),
      index,
      next: account.id === next,
      known,
      windows,
      ...(refusedUntil !== undefined ? { refusedUntil } : {}),
      ...(pastLine ? { pastLine } : {}),
      ready: pool.underLinesAt(account.id, now) <= now,
      boosted: pool.isBoosted(account.id, now),
      score: switchScore(windows, known, now),
    };
  });
}

/** `4h32m` — for the 5-hour window. */
export function formatHoursMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** `2d22h` — for the weekly window. */
export function formatDaysHours(ms: number): string {
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** `18% / 4h19m`; `0% / 已重置` after a reset; `—` when no run reported the window. */
function windowCell(view: AccountWindowView, format: (ms: number) => string): string {
  if (view.usedPercent === undefined) return '—';
  const reset = view.reset ? '已重置' : view.resetsInMs === undefined ? '—' : format(view.resetsInMs);
  return `${Math.round(view.usedPercent)}% / ${reset}`;
}

function stateCell(row: AccountRow): string {
  if (row.refusedUntil !== undefined) return `⛔ 额度用尽，${formatMonthDayTime(row.refusedUntil)} 恢复`;
  if (row.pastLine) return `⚠️ 已过${WINDOW_LABELS[row.pastLine]}切换线`;
  if (!row.known) return '还没运行过';
  const state = row.next ? '使用中' : '可用';
  const opened = WINDOW_KINDS.filter((kind) => row.windows[kind].graceFrom !== undefined);
  return opened.length > 0 ? `${state}（${opened.map((kind) => WINDOW_LABELS[kind]).join('、')}临近重置，切换线放宽）` : state;
}

/** `60%`, or `60→98%` while the window is about to reset and its line is opened. */
function lineCell(view: AccountWindowView): string {
  return view.graceFrom !== undefined ? `${view.graceFrom}→${view.line}%` : `${view.line}%`;
}

/** The accounts as one Markdown table; ✅ marks the account new runs use. */
export function accountsTable(rows: AccountRow[]): string {
  const out = [
    '| 账户 | 5 小时用量 / 重置 | 本周用量 / 重置 | 切换线（5 小时 / 本周） | 得分 | 状态 |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const five = row.windows.five_hour;
    const week = row.windows.seven_day;
    const role = row.index === 0 ? '主' : `备 ${row.index}`;
    out.push(
      `| ${row.next ? '✅ ' : ''}**${row.name}**（${role}，${row.id}） | ${windowCell(five, formatHoursMinutes)} | ${windowCell(week, formatDaysHours)} | ${lineCell(five)} / ${lineCell(week)}${row.boosted ? '（临时）' : ''} | ${Math.round(row.score * 100)} | ${stateCell(row)} |`,
    );
  }
  return out.join('\n');
}

/**
 * `⏳ 先到期先用：**汤欢** 本周 2d20h 后重置，离切换线还有 39 个百分点，新任务先用它。` —
 * the ready account whose weekly room runs out first, so `/accounts` says why
 * it leads, or why it does not take the next run. Undefined when no ready
 * account has a known weekly reset.
 */
export function expiringFirstNote(rows: AccountRow[]): string | undefined {
  const left = (row: AccountRow): number => row.windows.seven_day.line - (row.windows.seven_day.usedPercent ?? 0);
  const first = rows
    .filter((row) => row.ready && row.known && row.windows.seven_day.resetsInMs !== undefined)
    .sort((a, b) => a.windows.seven_day.resetsInMs! - b.windows.seven_day.resetsInMs! || a.index - b.index)[0];
  if (!first) return undefined;
  const head = `⏳ 先到期先用：**${first.name}** 本周 ${formatDaysHours(first.windows.seven_day.resetsInMs!)} 后重置，离切换线还有 ${Math.round(left(first))} 个百分点`;
  if (first.next) return `${head}，新任务先用它。`;
  const using = rows.find((row) => row.next);
  if (!using) return `${head}。`;
  const why =
    left(first) / first.windows.seven_day.line < WORTH_MOVING_ROOM
      ? '只剩这点不值得专门换号'
      : first.score > using.score
        ? `得分领先不到 ${Math.round(STICKY_MARGIN * 100)} 分，换号要整段对话重读一遍，不值得`
        : '它的 5 小时窗口余量不多，得分没拉开';
  return `${head}；${why}，新任务暂时还用 **${using.name}**。`;
}

/**
 * The account a switch without a name goes to: the best-scoring ready one
 * other than the main account. Not "other than the one new runs would use":
 * once the main account is past a line, that one is already the best ready
 * account — excluding it handed the switch to the second best.
 */
export function bestSwitchTarget(rows: AccountRow[]): AccountRow | undefined {
  return rows
    .filter((row) => row.index !== 0 && row.ready)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];
}

/** An account by id, its label or (for `default`) the CLI login's name; case-insensitive. */
export function findAccountRow(rows: AccountRow[], query: string): AccountRow | undefined {
  const q = query.trim().toLowerCase();
  return (
    rows.find((row) => row.id.toLowerCase() === q) ??
    rows.find((row) => row.name.toLowerCase() === q) ??
    rows.find((row) => row.aliases?.some((alias) => alias.toLowerCase() === q))
  );
}

/**
 * A temporary line the owner asked for with a switch by name (`/accounts
 * switch <name> 95`): each window whose own line is below `line` goes up to
 * it until that window's next reset (a full window length when the reset is
 * not known). Undefined when nothing rises. A switch never raises a line on
 * its own: without `line`, the account keeps its lines.
 */
export function switchBoost(pool: ClaudeAccountPool, id: string, line: number, now = Date.now()): ClaudeAccountEntry['boost'] {
  const windows = pool.windowViews(id, now);
  const boost: Partial<Record<WindowKind, LineBoost>> = {};
  for (const kind of WINDOW_KINDS) {
    if (pool.baseLineOf(id, kind, now) >= line) continue;
    boost[kind] = { line, until: now + (windows[kind].resetsInMs ?? WINDOW_MS[kind]) };
  }
  return Object.keys(boost).length > 0 ? boost : undefined;
}

/**
 * `焦银玲` / `焦银玲 95` / `焦银玲 95%`: the account a switch names and the
 * temporary line asked for with it, if any. A trailing number is a line only
 * after a name; on its own it is a name.
 */
export function parseSwitchQuery(query: string | undefined): { name?: string; line?: number } | { error: string } {
  const words = (query ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return {};
  const last = words.length > 1 ? /^(\d{1,3})%?$/.exec(words[words.length - 1]!) : null;
  if (!last) return { name: words.join(' ') };
  const line = Number(last[1]);
  if (line < 1 || line > 100) return { error: `切换线要是 1–100 的整数：${words[words.length - 1]}` };
  return { name: words.slice(0, -1).join(' '), line };
}

/**
 * Why a switch by hand may not make `row` the main account, or undefined
 * when it may: switches obey the switch lines like every automatic move. The
 * account must not be refused and must be below each line it will have after
 * the switch — its own line, or `line` where the owner raised it for now. A
 * raise already on the account does not count: a switch replaces it.
 */
export function switchRefusal(pool: ClaudeAccountPool, row: AccountRow, line?: number): string | undefined {
  if (row.refusedUntil !== undefined) return `额度用尽，${formatMonthDayTime(row.refusedUntil)} 恢复`;
  for (const kind of WINDOW_KINDS) {
    const used = row.windows[kind].usedPercent;
    const limit = Math.max(pool.baseLineOf(row.id, kind), pool.inGrace(row.id, kind) ? GRACE_LINE : 0, line ?? 0);
    if (used !== undefined && used >= limit) return `${WINDOW_LABELS[kind]}用量 ${Math.round(used)}%，已到 ${limit}% 的切换线`;
  }
  return undefined;
}
